import {
  type ClientTurnRequestId,
  type DynamicTool,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  createBridgeIo,
  decodeToolCallResponsePayload,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type NanoGptContentPart,
  type NanoGptMessage,
  type NanoGptToolCall,
  type NanoGptToolDefinition,
  NanoGptApiError,
  createNanoGptClient,
} from "./nano-gpt-client.js";
import {
  MAX_TOOL_ROUNDS,
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_DEFAULT_BASE_URL,
  NANO_GPT_DEFAULT_MODEL_ID,
  NANO_GPT_FALLBACK_MODELS,
  modelDisplayName,
  nanoGptProviderOptionsSchema,
} from "./vocabulary.js";

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;
let outboundRequestCounter = 0;
const MAX_MODEL_LIST = 400;
const STOP_SETTLE_TIMEOUT_MS = 2000;

interface QueuedPrompt {
  input: readonly PromptInput[];
  options: TurnOptions;
  clientRequestId: ClientTurnRequestId | undefined;
}

interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  tools: ReadonlyMap<string, DynamicTool>;
  messages: NanoGptMessage[];
  turnCounter: number;
  usageTotal: ThreadEventTokenUsageBreakdown;
  activeTurn: ActiveTurn | null;
  queue: QueuedPrompt[];
}

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
}

interface TurnOptions {
  model: string | undefined;
  instructions: string | undefined;
  providerOptions: unknown;
  envVars: Record<string, string> | undefined;
}

const sessions = new Map<string, Session>();

type JsonRpcId = string | number;

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function sendRequest(method: string, params: Record<string, unknown>): string {
  outboundRequestCounter += 1;
  const id = `nano-gpt-req-${outboundRequestCounter}`;
  io.send({ jsonrpc: "2.0", id, method, params });
  return id;
}

interface PendingToolCall {
  session: Session;
  resolve: (reply: { content: string; isError: boolean }) => void;
}

const pendingToolCalls = new Map<string, PendingToolCall>();

function apiKey(envVars: Record<string, string> | undefined): string {
  return (envVars?.[NANO_GPT_API_KEY_ENV] ?? "").trim();
}

function baseUrl(
  providerOptions: unknown,
  envVars?: Record<string, string>,
): string {
  const parsed = nanoGptProviderOptionsSchema.safeParse(providerOptions);
  if (parsed.success && parsed.data.baseUrl !== null) {
    return parsed.data.baseUrl;
  }
  return (
    envVars?.[NANO_GPT_BASE_URL_ENV] ??
    process.env[NANO_GPT_BASE_URL_ENV] ??
    NANO_GPT_DEFAULT_BASE_URL
  );
}

function modelId(options: TurnOptions): string {
  const parsed = nanoGptProviderOptionsSchema.safeParse(options.providerOptions);
  if (options.model !== undefined && options.model !== "") {
    return options.model;
  }
  if (parsed.success && parsed.data.model !== "") {
    return parsed.data.model;
  }
  return NANO_GPT_DEFAULT_MODEL_ID;
}

function openSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  dynamicTools: readonly DynamicTool[] | undefined;
}): Session {
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    tools: new Map(
      (args.dynamicTools ?? []).map((tool) => [tool.name, tool]),
    ),
    messages: [],
    turnCounter: 0,
    usageTotal: ZERO_TOKEN_USAGE,
    activeTurn: null,
    queue: [],
  };
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
  });
  emitDeltas(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

/**
 * Timeline item ids must be unique per logical item. The round number keeps
 * ids distinct across the model rounds of one turn (a tool-call id such as
 * `call_0` repeats from round to round).
 */
function itemId(session: Session, name: string, round: number): string {
  return `nano-gpt-${session.providerThreadId}-t${session.turnCounter}-r${round}-${name}`;
}

function userContent(input: readonly PromptInput[]): string | NanoGptContentPart[] {
  const parts: NanoGptContentPart[] = [];
  for (const item of input) {
    if (item.type === "text") {
      parts.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      parts.push({ type: "image_url", image_url: { url: item.url } });
      continue;
    }
    if (item.type === "localImage") {
      parts.push({ type: "text", text: `[local image: ${item.path}]` });
      continue;
    }
    parts.push({
      type: "text",
      text: `[file: ${item.name ?? item.path}]`,
    });
  }
  if (parts.every((part) => part.type === "text")) {
    return parts
      .map((part) => (part as Extract<NanoGptContentPart, { type: "text" }>).text)
      .join("");
  }
  return parts;
}

function setSystemMessage(session: Session, options: TurnOptions): void {
  const text = [
    options.instructions ?? "",
    `Working directory: ${session.cwd}`,
  ]
    .filter((line) => line !== "")
    .join("\n\n");
  if (text === "") {
    return;
  }
  const first = session.messages[0];
  if (first !== undefined && first.role === "system") {
    session.messages[0] = { role: "system", content: text };
    return;
  }
  session.messages.unshift({ role: "system", content: text });
}

function toolDefinitions(session: Session): NanoGptToolDefinition[] {
  return [...session.tools.values()].map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

type ParsedToolArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Tool arguments come from the model and tools have side effects, so invalid
 * JSON is an error, never an empty object. An empty string means "no
 * arguments" and is valid.
 */
function parseToolArguments(raw: string): ParsedToolArguments {
  const text = raw.trim() === "" ? "{}" : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid JSON",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

const CANCELLED_TOOL_REPLY = {
  content: "Tool call cancelled.",
  isError: true,
} as const;

/**
 * Asks bb to run a tool. The returned promise always settles: either bb
 * answers, or the turn is aborted and the pending entry is removed.
 */
function requestToolCall(
  session: Session,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  if (signal.aborted) {
    return Promise.resolve(CANCELLED_TOOL_REPLY);
  }
  const requestId = sendRequest(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
    providerThreadId: session.providerThreadId,
    threadId: session.threadId,
    turnId: null,
    callId,
    tool,
    arguments: args,
  });
  return new Promise((resolve) => {
    const onAbort = (): void => {
      if (pendingToolCalls.delete(requestId)) {
        resolve(CANCELLED_TOOL_REPLY);
      }
    };
    pendingToolCalls.set(requestId, {
      session,
      resolve: (reply) => {
        signal.removeEventListener("abort", onAbort);
        resolve(reply);
      },
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function estimatedUsage(messages: readonly NanoGptMessage[]): ThreadEventTokenUsageBreakdown {
  const chars = messages
    .map((message) =>
      typeof message.content === "string" ? message.content.length : 0,
    )
    .reduce((sum, value) => sum + value, 0);
  return {
    ...ZERO_TOKEN_USAGE,
    inputTokens: Math.ceil(chars / 4),
    outputTokens: 0,
    totalTokens: Math.ceil(chars / 4),
  };
}

function runTurn(args: {
  session: Session;
  input: readonly PromptInput[];
  options: TurnOptions;
  clientRequestId: ClientTurnRequestId | undefined;
}): void {
  const { session } = args;
  // One turn at a time per session: a second start waits in the queue instead
  // of mutating the same message history in parallel.
  if (session.activeTurn !== null) {
    session.queue.push({
      input: args.input,
      options: args.options,
      clientRequestId: args.clientRequestId,
    });
    return;
  }
  const controller = new AbortController();
  const activeTurn: ActiveTurn = {
    controller,
    done: Promise.resolve(),
  };
  session.activeTurn = activeTurn;
  const work = runTurnWork(args, controller.signal)
    .catch((error: unknown) => {
      console.error("nano-gpt turn failed", error);
    })
    .finally(() => {
      if (session.activeTurn === activeTurn) {
        session.activeTurn = null;
        drainQueue(session);
      }
    });
  activeTurn.done = work;
}

function drainQueue(session: Session): void {
  const next = session.queue.shift();
  if (next === undefined) {
    return;
  }
  runTurn({
    session,
    input: next.input,
    options: next.options,
    clientRequestId: next.clientRequestId,
  });
}

function toolPresentation(
  session: Session,
  toolName: string,
): DynamicTool["presentation"] {
  return session.tools.get(toolName)?.presentation;
}

function closeTextItem(
  session: Session,
  key: string,
  channel: "agentMessage" | "reasoningText",
  text: string,
): void {
  emitDeltas(session.threadId, [
    { kind: "item.textClose", key: { providerItemId: key }, channel, text },
  ]);
}

async function runTurnWork(
  args: {
    session: Session;
    input: readonly PromptInput[];
    options: TurnOptions;
    clientRequestId: ClientTurnRequestId | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  const { session } = args;
  session.turnCounter += 1;
  const threadId = session.threadId;

  if (args.clientRequestId !== undefined) {
    emitDeltas(threadId, [
      { kind: "input.accepted", clientRequestId: args.clientRequestId },
    ]);
  }
  emitDeltas(threadId, [{ kind: "turn.open" }]);

  const key = apiKey(args.options.envVars);
  if (key === "") {
    const message =
      "No NanoGPT API key is configured; paste one into the NanoGPT provider plugin settings (get a key at https://nano-gpt.com/api).";
    emitDeltas(threadId, [
      { kind: "provider.error", message },
      { kind: "turn.boundary", status: "failed", error: { message } },
    ]);
    return;
  }

  const model = modelId(args.options);
  setSystemMessage(session, args.options);
  session.messages.push({ role: "user", content: userContent(args.input) });
  const client = createNanoGptClient({
    baseUrl: baseUrl(args.options.providerOptions, args.options.envVars),
    apiKey: key,
  });
  const tools = toolDefinitions(session);

  let messageTextKey: string | null = null;
  let messageText = "";
  let reasoningKey: string | null = null;
  // Usage is summed over every model round of the turn.
  let turnUsage: ThreadEventTokenUsageBreakdown = ZERO_TOKEN_USAGE;

  try {
    let rounds = 0;
    while (true) {
      rounds += 1;
      if (rounds > MAX_TOOL_ROUNDS) {
        throw new NanoGptApiError({
          status: 0,
          message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`,
        });
      }
      messageTextKey = null;
      messageText = "";
      reasoningKey = null;
      const roundEstimate = estimatedUsage(session.messages);

      const stream = client.streamChatCompletion({
        model,
        messages: session.messages,
        tools: tools.length > 0 ? tools : undefined,
        signal,
      });

      let sawFinal = false;
      let finalContent = "";
      let finalToolCalls: NanoGptToolCall[] = [];
      let finalUsage: ThreadEventTokenUsageBreakdown | null = null;

      for await (const event of stream) {
        if (event.type === "textDelta") {
          if (messageTextKey === null) {
            messageTextKey = itemId(session, "message", rounds);
            emitDeltas(threadId, [
              {
                kind: "item.open",
                key: { providerItemId: messageTextKey },
                item: { type: "agentMessage", text: "" },
              },
            ]);
          }
          messageText += event.text;
          emitDeltas(threadId, [
            {
              kind: "item.textDelta",
              key: { providerItemId: messageTextKey },
              channel: "agentMessage",
              text: event.text,
            },
          ]);
          continue;
        }
        if (event.type === "reasoningDelta") {
          if (reasoningKey === null) {
            reasoningKey = itemId(session, "reasoning", rounds);
          }
          emitDeltas(threadId, [
            {
              kind: "item.textDelta",
              key: { providerItemId: reasoningKey },
              channel: "reasoningText",
              text: event.text,
            },
          ]);
          continue;
        }
        sawFinal = true;
        finalContent = event.content;
        finalToolCalls = event.toolCalls;
        finalUsage =
          event.usage === null
            ? null
            : {
                ...ZERO_TOKEN_USAGE,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                totalTokens: event.usage.totalTokens,
              };
      }

      if (!sawFinal) {
        throw new NanoGptApiError({
          status: 0,
          message: "NanoGPT stream ended without a final message.",
        });
      }
      if (reasoningKey !== null) {
        closeTextItem(session, reasoningKey, "reasoningText", "");
      }
      if (messageTextKey !== null) {
        closeTextItem(
          session,
          messageTextKey,
          "agentMessage",
          finalContent === "" ? messageText : finalContent,
        );
      }
      turnUsage = addTokenUsage(turnUsage, finalUsage ?? roundEstimate);

      if (finalToolCalls.length === 0) {
        session.messages.push({
          role: "assistant",
          content: finalContent,
        });
        break;
      }

      session.messages.push({
        role: "assistant",
        content: finalContent === "" ? null : finalContent,
        tool_calls: finalToolCalls,
      });

      for (const call of finalToolCalls) {
        const callId = itemId(session, `tool-${call.id}`, rounds);
        const parsedArgs = parseToolArguments(call.function.arguments);
        if (!parsedArgs.ok) {
          // Never run a tool with guessed arguments; tell the model so it can
          // retry with valid JSON.
          emitDeltas(threadId, [
            {
              kind: "item.open",
              key: { providerItemId: callId },
              item: {
                type: "tool",
                tool: call.function.name,
                server: "bb",
                args: {},
              },
            },
            {
              kind: "item.close",
              key: { providerItemId: callId },
              status: "failed",
              item: {
                type: "tool",
                tool: call.function.name,
                server: "bb",
                args: {},
                error: `Invalid tool arguments: ${parsedArgs.error}`,
              },
            },
          ]);
          session.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Error: the arguments for ${call.function.name} were not valid JSON (${parsedArgs.error}). The tool was not run. Call it again with a valid JSON object.`,
          });
          continue;
        }
        const toolArgs = parsedArgs.value;
        const presentation = toolPresentation(session, call.function.name);
        emitDeltas(threadId, [
          {
            kind: "item.open",
            key: { providerItemId: callId },
            item: {
              type: "tool",
              tool: call.function.name,
              server: "bb",
              args: toolArgs,
            },
            ...(presentation === undefined ? {} : { presentation }),
          },
        ]);
        const reply = await requestToolCall(
          session,
          callId,
          call.function.name,
          toolArgs,
          signal,
        );
        if (signal.aborted || !sessions.has(threadId)) {
          throw new DOMException("Turn aborted", "AbortError");
        }
        emitDeltas(threadId, [
          {
            kind: "item.close",
            key: { providerItemId: callId },
            status: reply.isError ? "failed" : "completed",
            item: {
              type: "tool",
              tool: call.function.name,
              server: "bb",
              args: toolArgs,
              ...(reply.isError
                ? { error: reply.content }
                : { result: reply.content }),
            },
            ...(presentation === undefined ? {} : { presentation }),
          },
        ]);
        session.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: reply.content === "" ? "OK" : reply.content,
        });
      }

    }

    session.usageTotal = addTokenUsage(session.usageTotal, turnUsage);
    emitDeltas(threadId, [
      {
        kind: "usage",
        total: session.usageTotal,
        last: turnUsage,
        modelContextWindow: null,
      },
      { kind: "turn.boundary", status: "completed" },
    ]);
  } catch (error) {
    const aborted =
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    if (aborted) {
      if (reasoningKey !== null) {
        closeTextItem(session, reasoningKey, "reasoningText", "");
      }
      if (messageTextKey !== null) {
        closeTextItem(session, messageTextKey, "agentMessage", messageText);
      }
      emitDeltas(threadId, [{ kind: "turn.boundary", status: "interrupted" }]);
      return;
    }
    const message =
      error instanceof NanoGptApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    emitDeltas(threadId, [
      { kind: "provider.error", message },
      { kind: "turn.boundary", status: "failed", error: { message } },
    ]);
  }
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

function healthResult(): ProviderHealthResult {
  const key = (process.env[NANO_GPT_API_KEY_ENV] ?? "").trim();
  return {
    supported: true,
    health: {
      status: key === "" ? "unauthenticated" : "ready",
      statusMessage:
        key === ""
          ? "Paste your NanoGPT API key into the NanoGPT provider plugin settings to use NanoGPT."
          : null,
      accountEmail: null,
      planLabel: null,
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}

function turnOptionsOf(options: {
  model?: string;
  instructions?: string;
  providerOptions?: Record<string, unknown>;
  envVars?: Record<string, string>;
}): TurnOptions {
  return {
    model: options.model,
    instructions: options.instructions,
    providerOptions: options.providerOptions ?? {},
    envVars: options.envVars,
  };
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        // The bridge keeps conversation history in memory only, so it cannot
        // restore a session after a restart. Do not claim otherwise.
        sessionRestore: false,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    void (async () => {
      const key = apiKey(parsed.data.envVars);
      if (key === "") {
        io.sendResult(id, { models: [], selectedOnlyModels: [] });
        return;
      }
      try {
        const ids = await createNanoGptClient({
          baseUrl: baseUrl(undefined, parsed.data.envVars),
          apiKey: key,
        }).listModels();
        const preferred = new Set(
          NANO_GPT_FALLBACK_MODELS.map((model) => model.id),
        );
        const unique = [...new Set(ids)];
        unique.sort((left, right) => {
          const leftPreferred = preferred.has(left) ? 1 : 0;
          const rightPreferred = preferred.has(right) ? 1 : 0;
          if (leftPreferred !== rightPreferred) {
            return rightPreferred - leftPreferred;
          }
          return left.localeCompare(right);
        });
        const models = unique.slice(0, MAX_MODEL_LIST).map((modelId, index) => ({
          id: modelId,
          model: modelId,
          displayName: modelDisplayName(modelId),
          description: "Chat model routed through NanoGPT.",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Default" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: index === 0,
        }));
        io.sendResult(id, { models, selectedOnlyModels: [] });
      } catch {
        io.sendResult(id, { models: [], selectedOnlyModels: [] });
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerHealth,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, healthResult());
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStart,
        parsed.error.issues,
      );
      return;
    }
    threadCounter += 1;
    const providerThreadId = `nano_gpt_${instanceNonce}_${threadCounter}`;
    const session = openSession({
      threadId: parsed.data.threadId,
      providerThreadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools,
    });
    io.sendResult(id, { providerThreadId, sessionRestorable: false });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      runTurn({
        session,
        input: parsed.data.input,
        options: turnOptionsOf(parsed.data.options),
        clientRequestId: undefined,
      });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
      return;
    }
    openSession({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools,
    });
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: false,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    io.sendResult(id, {});
    runTurn({
      session,
      input: parsed.data.input,
      options: turnOptionsOf(parsed.data.options),
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined || session.activeTurn === null) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
      );
      return;
    }
    emitDeltas(session.threadId, [
      { kind: "input.accepted", clientRequestId: parsed.data.clientRequestId },
    ]);
    session.queue.push({
      input: parsed.data.input,
      options: turnOptionsOf(parsed.data.options),
      clientRequestId: parsed.data.clientRequestId,
    });
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendResult(id, {});
      return;
    }
    session.queue.length = 0;
    const activeTurn = session.activeTurn;
    if (parsed.data.intent === "interrupt" && activeTurn !== null) {
      activeTurn.controller.abort();
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS).unref?.();
      });
      void Promise.race([activeTurn.done, timeout]).then(() => {
        sessions.delete(parsed.data.threadId);
        io.sendResult(id, {});
      });
      return;
    }
    // Releasing a thread must not leave its turn running in the background.
    activeTurn?.controller.abort();
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

const jsonRpcResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function handleResponse(message: unknown): void {
  const parsed = jsonRpcResponseSchema.safeParse(message);
  if (!parsed.success || typeof parsed.data.id !== "string") {
    return;
  }
  const pending = pendingToolCalls.get(parsed.data.id);
  if (pending === undefined) {
    return;
  }
  pendingToolCalls.delete(parsed.data.id);
  if (!sessions.has(pending.session.threadId)) {
    return;
  }
  if (parsed.data.error !== undefined) {
    const error = z
      .object({ message: z.string() })
      .safeParse(parsed.data.error);
    pending.resolve({
      content: error.success ? error.data.message : "tool call failed",
      isError: true,
    });
    return;
  }
  const decoded = decodeToolCallResponsePayload(parsed.data.result);
  pending.resolve({ content: decoded.content, isError: decoded.isError });
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") {
    handleResponse(message);
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start() {},
});




