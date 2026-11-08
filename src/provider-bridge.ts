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
  /** True once `input.accepted` was sent (turn/steer acknowledges at once). */
  accepted: boolean;
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

interface OpenTool {
  tool: string;
  args: Record<string, unknown>;
  presentation: DynamicTool["presentation"];
}

/** Everything a turn has opened in the timeline, so it can always be closed. */
interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  /** True once the turn has sent its single terminal `turn.boundary`. */
  settled: boolean;
  reasoningKey: string | null;
  messageKey: string | null;
  messageText: string;
  openTools: Map<string, OpenTool>;
  /** Tool-call ids the model issued that have no answer in the history yet. */
  unansweredToolCalls: string[];
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

function abortError(): DOMException {
  return new DOMException("Turn aborted", "AbortError");
}

function newActiveTurn(): ActiveTurn {
  return {
    controller: new AbortController(),
    done: Promise.resolve(),
    settled: false,
    reasoningKey: null,
    messageKey: null,
    messageText: "",
    openTools: new Map(),
    unansweredToolCalls: [],
  };
}

type TurnOutcome =
  | { status: "completed"; usage: ThreadEventTokenUsageBreakdown }
  | { status: "interrupted" }
  | { status: "failed"; message: string };

/**
 * The only place a turn ends. It closes every item the turn left open, keeps
 * the model history valid (every tool call gets an answer), and sends exactly
 * one terminal `turn.boundary`. Calling it again for the same turn does
 * nothing, so stop, failure and normal completion can never both report.
 */
function settleTurn(
  session: Session,
  turn: ActiveTurn,
  outcome: TurnOutcome,
): void {
  if (turn.settled) {
    return;
  }
  turn.settled = true;
  const itemStatus = outcome.status === "failed" ? "failed" : "interrupted";
  const deltas: ThreadDelta[] = [];
  if (turn.reasoningKey !== null) {
    deltas.push({
      kind: "item.textClose",
      key: { providerItemId: turn.reasoningKey },
      channel: "reasoningText",
      text: "",
    });
    turn.reasoningKey = null;
  }
  if (turn.messageKey !== null) {
    deltas.push({
      kind: "item.textClose",
      key: { providerItemId: turn.messageKey },
      channel: "agentMessage",
      text: turn.messageText,
    });
    turn.messageKey = null;
  }
  for (const [key, open] of turn.openTools) {
    deltas.push({
      kind: "item.close",
      key: { providerItemId: key },
      status: itemStatus,
      item: {
        type: "tool",
        tool: open.tool,
        server: "bb",
        args: open.args,
      },
      ...(open.presentation === undefined
        ? {}
        : { presentation: open.presentation }),
    });
  }
  turn.openTools.clear();
  for (const callId of turn.unansweredToolCalls) {
    session.messages.push({
      role: "tool",
      tool_call_id: callId,
      content: "Tool call cancelled.",
    });
  }
  turn.unansweredToolCalls = [];
  if (outcome.status === "completed") {
    session.usageTotal = addTokenUsage(session.usageTotal, outcome.usage);
    deltas.push(
      {
        kind: "usage",
        total: session.usageTotal,
        last: outcome.usage,
        modelContextWindow: null,
      },
      { kind: "turn.boundary", status: "completed" },
    );
  } else if (outcome.status === "interrupted") {
    deltas.push({ kind: "turn.boundary", status: "interrupted" });
  } else {
    deltas.push(
      { kind: "provider.error", message: outcome.message },
      {
        kind: "turn.boundary",
        status: "failed",
        error: { message: outcome.message },
      },
    );
  }
  emitDeltas(session.threadId, deltas);
}

function runTurn(args: {
  session: Session;
  input: readonly PromptInput[];
  options: TurnOptions;
  clientRequestId: ClientTurnRequestId | undefined;
  /** True when `input.accepted` was already sent for this input. */
  accepted: boolean;
}): void {
  const { session } = args;
  // One turn at a time per session: a second start waits in the queue instead
  // of mutating the same message history in parallel.
  if (session.activeTurn !== null) {
    session.queue.push({
      input: args.input,
      options: args.options,
      clientRequestId: args.clientRequestId,
      accepted: args.accepted,
    });
    return;
  }
  const activeTurn = newActiveTurn();
  session.activeTurn = activeTurn;
  const work = runTurnWork(args, activeTurn)
    .catch((error: unknown) => {
      console.error("nano-gpt turn failed", error);
      settleTurn(session, activeTurn, {
        status: "failed",
        message: "The NanoGPT turn failed unexpectedly.",
      });
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
    accepted: next.accepted,
  });
}

function toolPresentation(
  session: Session,
  toolName: string,
): DynamicTool["presentation"] {
  return session.tools.get(toolName)?.presentation;
}

/** Closes the text and reasoning items of one model round. */
function closeRoundText(
  session: Session,
  turn: ActiveTurn,
  finalText: string,
): void {
  const deltas: ThreadDelta[] = [];
  if (turn.reasoningKey !== null) {
    deltas.push({
      kind: "item.textClose",
      key: { providerItemId: turn.reasoningKey },
      channel: "reasoningText",
      text: "",
    });
  }
  if (turn.messageKey !== null) {
    deltas.push({
      kind: "item.textClose",
      key: { providerItemId: turn.messageKey },
      channel: "agentMessage",
      text: finalText === "" ? turn.messageText : finalText,
    });
  }
  turn.reasoningKey = null;
  turn.messageKey = null;
  turn.messageText = "";
  if (deltas.length > 0) {
    emitDeltas(session.threadId, deltas);
  }
}

async function runTurnWork(
  args: {
    session: Session;
    input: readonly PromptInput[];
    options: TurnOptions;
    clientRequestId: ClientTurnRequestId | undefined;
    accepted: boolean;
  },
  turn: ActiveTurn,
): Promise<void> {
  const { session } = args;
  const signal = turn.controller.signal;
  const threadId = session.threadId;
  session.turnCounter += 1;

  // Nothing may be emitted once the turn has settled (for example after a
  // stop): the terminal boundary has already been sent.
  const emit = (deltas: ThreadDelta[]): void => {
    if (!turn.settled) {
      emitDeltas(threadId, deltas);
    }
  };

  // A steered prompt was acknowledged when it arrived; acknowledge every other
  // input exactly once, here.
  if (args.clientRequestId !== undefined && !args.accepted) {
    emit([{ kind: "input.accepted", clientRequestId: args.clientRequestId }]);
  }
  emit([{ kind: "turn.open" }]);

  const key = apiKey(args.options.envVars);
  if (key === "") {
    settleTurn(session, turn, {
      status: "failed",
      message:
        "No NanoGPT API key is configured; paste one into the NanoGPT provider plugin settings (get a key at https://nano-gpt.com/api).",
    });
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
      let finishReason: string | null = null;

      for await (const event of stream) {
        if (turn.settled) {
          throw abortError();
        }
        if (event.type === "textDelta") {
          if (turn.messageKey === null) {
            turn.messageKey = itemId(session, "message", rounds);
            emit([
              {
                kind: "item.open",
                key: { providerItemId: turn.messageKey },
                item: { type: "agentMessage", text: "" },
              },
            ]);
          }
          turn.messageText += event.text;
          emit([
            {
              kind: "item.textDelta",
              key: { providerItemId: turn.messageKey },
              channel: "agentMessage",
              text: event.text,
            },
          ]);
          continue;
        }
        if (event.type === "reasoningDelta") {
          if (turn.reasoningKey === null) {
            turn.reasoningKey = itemId(session, "reasoning", rounds);
          }
          emit([
            {
              kind: "item.textDelta",
              key: { providerItemId: turn.reasoningKey },
              channel: "reasoningText",
              text: event.text,
            },
          ]);
          continue;
        }
        sawFinal = true;
        finalContent = event.content;
        finalToolCalls = event.toolCalls;
        finishReason = event.finishReason;
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
      closeRoundText(session, turn, finalContent);
      turnUsage = addTokenUsage(turnUsage, finalUsage ?? roundEstimate);

      if (finishReason === "length") {
        // The model hit its output limit: the text, and any tool-call
        // arguments, are cut off. Keep what the user saw, but never present
        // it as a finished answer and never run a half-written tool call.
        if (finalContent !== "") {
          session.messages.push({ role: "assistant", content: finalContent });
        }
        throw new NanoGptApiError({
          status: 0,
          message:
            "The model stopped because it reached its output length limit, so the answer is incomplete. Ask it to continue, or choose a model with a larger output limit.",
        });
      }

      if (finalToolCalls.length === 0) {
        session.messages.push({ role: "assistant", content: finalContent });
        break;
      }

      session.messages.push({
        role: "assistant",
        content: finalContent === "" ? null : finalContent,
        tool_calls: finalToolCalls,
      });
      turn.unansweredToolCalls = finalToolCalls.map((call) => call.id);
      const markAnswered = (id: string): void => {
        turn.unansweredToolCalls = turn.unansweredToolCalls.filter(
          (pendingId) => pendingId !== id,
        );
      };

      for (const call of finalToolCalls) {
        if (signal.aborted || turn.settled) {
          throw abortError();
        }
        const callId = itemId(session, `tool-${call.id}`, rounds);
        const parsedArgs = parseToolArguments(call.function.arguments);
        if (!parsedArgs.ok) {
          // Never run a tool with guessed arguments; tell the model so it can
          // retry with valid JSON.
          emit([
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
          markAnswered(call.id);
          continue;
        }
        const toolArgs = parsedArgs.value;
        const presentation = toolPresentation(session, call.function.name);
        turn.openTools.set(callId, {
          tool: call.function.name,
          args: toolArgs,
          presentation,
        });
        emit([
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
        if (signal.aborted || turn.settled || !sessions.has(threadId)) {
          // Left in openTools and unansweredToolCalls on purpose: settleTurn
          // closes the item as interrupted and answers the call in history.
          throw abortError();
        }
        turn.openTools.delete(callId);
        emit([
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
        markAnswered(call.id);
      }
    }

    settleTurn(session, turn, { status: "completed", usage: turnUsage });
  } catch (error) {
    const aborted =
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    if (aborted) {
      settleTurn(session, turn, { status: "interrupted" });
      return;
    }
    settleTurn(session, turn, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
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
        accepted: false,
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
      accepted: false,
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
      // Acknowledged just above; the queued run must not acknowledge it again.
      accepted: true,
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
        // If the turn did not settle in time (for example a hung request),
        // settle it here so an interrupt always ends in an interrupted
        // boundary. This is a no-op when the turn already settled.
        settleTurn(session, activeTurn, { status: "interrupted" });
        sessions.delete(parsed.data.threadId);
        io.sendResult(id, {});
      });
      return;
    }
    if (activeTurn !== null) {
      // A release is not an interruption: end the turn silently, without a
      // terminal event, and make sure nothing more is emitted for it.
      activeTurn.settled = true;
      activeTurn.controller.abort();
    }
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




