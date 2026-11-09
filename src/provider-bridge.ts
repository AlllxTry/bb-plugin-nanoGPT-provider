import {
  type BridgeExecutionOptions,
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
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { describeAttachedFile, readAttachedImage, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "./attachments.js";
import { normalizeBaseUrl } from "./base-url.js";
import { toolControlsSchema, unsupportedPermissionPolicy, type ToolControls } from "./permissions.js";
import { toolApprovalAllowed, toolApprovalPresentation } from "./tool-approval.js";
import { boundedHistoryText, estimateTextTokens, fitContext } from "./context.js";
import { restoreNanoGptHistory } from "./history-adapter.js";
import {
  HISTORY_TOOL_NAME,
  MAX_HISTORY_PAGES,
  historyPageSchema,
  encodeContextCheckpoint,
  INPUT_NOT_RETAINED_NOTICE,
} from "./history-protocol.js";
import {
  type NanoGptContentPart,
  type NanoGptMessage,
  type NanoGptModelCatalogEntry,
  type NanoGptToolCall,
  type NanoGptToolDefinition,
  NanoGptApiError,
  createNanoGptClient,
} from "./nano-gpt-client.js";
import {
  normalizeReasoningEfforts,
  reasoningOptions,
  resolveReasoningSelection,
  validateReasoningSelection,
  type NanoGptReasoningEffort,
  type NanoGptReasoningSelection,
} from "./reasoning.js";
import {
  MAX_TOOL_ROUNDS,
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_DEFAULT_BASE_URL,
  NANO_GPT_DEFAULT_MODEL_ID,
  NANO_GPT_FALLBACK_MODELS,
  modelDisplayName,
  nanoGptProviderOptionsSchema,
  normalizeModelId,
} from "./vocabulary.js";

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;
let outboundRequestCounter = 0;
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
  disallowedTools: ReadonlySet<string>;
  messages: NanoGptMessage[];
  completedTurnEnds: number[];
  turnCounter: number;
  usageTotal: ThreadEventTokenUsageBreakdown;
  activeTurn: ActiveTurn | null;
  queue: QueuedPrompt[];
  restorationRequired: boolean;
}

interface OpenTool {
  tool: string;
  args: Record<string, unknown>;
  presentation: DynamicTool["presentation"];
}

/** Everything a turn has opened in the timeline, so it can always be closed. */
interface ActiveTurn {
  clientRequestId: string | null;
  controller: AbortController;
  done: Promise<void>;
  /** True once the turn has sent its single terminal `turn.boundary`. */
  settled: boolean;
  reasoningKey: string | null;
  messageKey: string | null;
  messageText: string;
  historyStart: number | null;
  openTools: Map<string, OpenTool>;
  /** Tool-call ids the model issued that have no answer in the history yet. */
  unansweredToolCalls: string[];
}

type TurnOptions = Readonly<BridgeExecutionOptions>;

const sessions = new Map<string, Session>();

const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const MODEL_CATALOG_MAX_ENTRIES = 16;
const modelCatalogCache = new Map<string, {
  expiresAt: number;
  entries: Map<string, NanoGptModelCatalogEntry>;
}>();

function modelCatalogCacheKey(url: string, key: string): string {
  return createHash("sha256").update(`${url}\n${key}`).digest("hex");
}

function invalidateModelCatalog(url: string, key: string): void {
  modelCatalogCache.delete(modelCatalogCacheKey(url, key));
}

async function modelCatalog(
  client: ReturnType<typeof createNanoGptClient>,
  url: string,
  key: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<Map<string, NanoGptModelCatalogEntry>> {
  const cacheKey = modelCatalogCacheKey(url, key);
  const now = Date.now();
  const cached = modelCatalogCache.get(cacheKey);
  if (!refresh && cached !== undefined && cached.expiresAt > now) {
    modelCatalogCache.delete(cacheKey);
    modelCatalogCache.set(cacheKey, cached);
    return cached.entries;
  }
  if (cached !== undefined) modelCatalogCache.delete(cacheKey);
  const records = await client.listModelCatalog(signal);
  const result = new Map<string, NanoGptModelCatalogEntry>();
  for (const record of records) {
    const previous = result.get(record.id);
    if (previous === undefined) result.set(record.id, record);
    else if (JSON.stringify(previous.reasoningEfforts) !== JSON.stringify(record.reasoningEfforts)) {
      result.set(record.id, { id: record.id, reasoningEfforts: undefined });
    }
  }
  modelCatalogCache.set(cacheKey, { expiresAt: Date.now() + MODEL_CATALOG_TTL_MS, entries: result });
  while (modelCatalogCache.size > MODEL_CATALOG_MAX_ENTRIES) {
    const oldest = modelCatalogCache.keys().next().value;
    if (oldest === undefined) break;
    modelCatalogCache.delete(oldest);
  }
  return result;
}

function catalogEfforts(entry: NanoGptModelCatalogEntry | undefined): NanoGptReasoningEffort[] {
  return normalizeReasoningEfforts(entry?.reasoningEfforts);
}

function assertModelEffort(
  selection: NanoGptReasoningSelection,
  entry: NanoGptModelCatalogEntry | undefined,
): NanoGptReasoningSelection {
  return validateReasoningSelection(selection, catalogEfforts(entry));
}

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
const pendingApprovals = new Map<string, {
  session: Session;
  resolve: (allowed: boolean) => void;
}>();

function apiKey(envVars: Record<string, string> | undefined): string {
  return (envVars?.[NANO_GPT_API_KEY_ENV] ?? "").trim();
}

function baseUrl(
  providerOptions: unknown,
  envVars?: Record<string, string>,
): string {
  const parsed = nanoGptProviderOptionsSchema.pick({ baseUrl: true }).partial().parse(providerOptions ?? {});
  return normalizeBaseUrl(parsed.baseUrl ??
    envVars?.[NANO_GPT_BASE_URL_ENV] ??
    process.env[NANO_GPT_BASE_URL_ENV] ??
    NANO_GPT_DEFAULT_BASE_URL
  );
}

function modelId(options: TurnOptions): string {
  const parsed = nanoGptProviderOptionsSchema.safeParse(options.providerOptions);
  if (options.model !== undefined && options.model !== "") {
    return normalizeModelId(options.model);
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
  tools: ReadonlyMap<string, DynamicTool>;
  disallowedTools: readonly string[] | undefined;
  restorationRequired: boolean;
}): Session {
  const previous = sessions.get(args.threadId);
  if (previous !== undefined) {
    previous.queue.length = 0;
    if (previous.activeTurn !== null) {
      previous.activeTurn.settled = true;
      previous.activeTurn.controller.abort();
    }
  }
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    tools: args.tools,
    disallowedTools: new Set(args.disallowedTools ?? []),
    messages: [],
    completedTurnEnds: [],
    turnCounter: 0,
    usageTotal: ZERO_TOKEN_USAGE,
    activeTurn: null,
    queue: [],
    restorationRequired: args.restorationRequired,
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

async function userContent(input: readonly PromptInput[], signal: AbortSignal): Promise<string | NanoGptContentPart[]> {
  const parts: NanoGptContentPart[] = [];
  let imageBytes = 0;
  for (const item of input) {
    signal.throwIfAborted();
    if (item.type === "text") {
      parts.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      if (item.url.startsWith("data:")) {
        const size = Buffer.byteLength(item.url);
        if (size > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw new Error("Attached image exceeds the image size limit.");
        imageBytes += Math.ceil(size * 3 / 4);
      }
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error("Attached images exceed the combined image size limit.");
      parts.push({ type: "image_url", image_url: { url: item.url } });
      continue;
    }
    if (item.type === "localImage") {
      const image = await readAttachedImage(item, signal);
      imageBytes += image.byteLength;
      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error("Attached images exceed the combined image size limit.");
      parts.push({ type: "image_url", image_url: { url: image.url } });
      continue;
    }
    parts.push({
      type: "text",
      text: await describeAttachedFile(item, signal),
    });
  }
  if (parts.every((part) => part.type === "text")) {
    return parts
      .map((part) => (part as Extract<NanoGptContentPart, { type: "text" }>).text)
      .join("");
  }
  return parts;
}

function setSystemMessage(session: Session, options: TurnOptions, planMode: boolean): void {
  const text = [
    options.instructions ?? "",
    `Working directory: ${session.cwd}`,
    ...(planMode ? ["Plan mode: outline a plan only. Do not execute tools or claim to have performed actions. Ask the user to switch out of plan mode to carry out the plan."] : []),
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

function toolDefinitions(session: Session, controls: ToolControls): NanoGptToolDefinition[] {
  return [...session.tools.values()].filter((tool) => toolRejection(session, tool.name, "model", controls) === null).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

async function restoreSessionHistory(
  session: Session,
  currentRequestId: ClientTurnRequestId | undefined,
  signal: AbortSignal,
  controls: ToolControls,
): Promise<void> {
  const rows: unknown[] = [];
  let afterSeq: number | null = null;
  let throughSeq: number | null = null;
  for (let pageNumber = 0; pageNumber < MAX_HISTORY_PAGES; pageNumber += 1) {
    signal.throwIfAborted();
    const result = await requestToolCall(
      session,
      `nano-gpt-history-${pageNumber}`,
      HISTORY_TOOL_NAME,
      { afterSeq, throughSeq, currentRequestId: currentRequestId ?? null },
      signal,
      "history",
      controls,
    );
    if (result.isError) throw new Error(`bb history could not be loaded: ${result.content}`);
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.content);
    } catch {
      throw new Error("bb history returned an invalid page.");
    }
    const parsed = historyPageSchema.safeParse(envelope);
    if (!parsed.success || parsed.data.threadId !== session.threadId) {
      throw new Error("bb history returned a malformed page or a different thread.");
    }
    if (throughSeq !== null && parsed.data.throughSeq !== throughSeq) {
      throw new Error("bb history changed during restoration.");
    }
    throughSeq = parsed.data.throughSeq;
    rows.push(...parsed.data.events);
    if (parsed.data.nextAfterSeq === null) {
      signal.throwIfAborted();
      const restored = restoreNanoGptHistory(rows, {
        ...(currentRequestId === undefined ? {} : { currentRequestId }),
      });
      const systemMessages = session.messages[0]?.role === "system" ? 1 : 0;
      session.messages.splice(systemMessages, 0, ...restored.messages);
      session.completedTurnEnds.push(
        ...restored.completedTurnEnds.map((end) => end + systemMessages),
      );
      session.restorationRequired = false;
      return;
    }
    if (afterSeq !== null && parsed.data.nextAfterSeq <= afterSeq) {
      throw new Error("bb history returned a non-advancing page cursor.");
    }
    afterSeq = parsed.data.nextAfterSeq;
  }
  throw new Error("bb history exceeds the supported restoration limit.");
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

type ToolCallSource = "model" | "history";

/** One eligibility rule for both advertised definitions and actual dispatch. */
function toolRejection(session: Session, tool: string, source: ToolCallSource, controls: ToolControls): string | null {
  if (session.disallowedTools.has(tool) || controls.disallowedTools.includes(tool)) {
    return `Error: tool "${tool}" is disallowed for this session. The tool was not run.`;
  }
  if (tool === HISTORY_TOOL_NAME && source !== "history") {
    return `Error: tool "${tool}" is reserved for internal history restoration. The tool was not run.`;
  }
  if (!session.tools.has(tool) || (source === "history" && tool !== HISTORY_TOOL_NAME)) {
    return `Error: unknown tool "${tool}". The tool was not run. Use only the tools provided for this session.`;
  }
  return null;
}

function requestToolApproval(
  session: Session,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ content: string; isError: true } | null> {
  const presentation = toolApprovalPresentation(tool, args);
  if (presentation === null) return Promise.resolve({ content: "Tool arguments are too large to review within bb's approval presentation limit. The tool was not run.", isError: true });
  if (signal.aborted) return Promise.resolve(CANCELLED_TOOL_REPLY);
  const id = `nano-gpt-req-${++outboundRequestCounter}`;
  return new Promise((resolve) => {
    const onAbort = () => finish(false);
    const finish = (allowed: boolean) => {
      if (!pendingApprovals.delete(id)) return;
      signal.removeEventListener("abort", onAbort);
      resolve(allowed && !signal.aborted && sessions.get(session.threadId) === session
        ? null
        : { content: "Tool approval was denied, cancelled, or unavailable. The tool was not run.", isError: true });
    };
    pendingApprovals.set(id, { session, resolve: finish });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      io.send({ jsonrpc: "2.0", id, method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, params: {
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        turnId: null,
        payload: {
          kind: "approval",
          availableDecisions: ["allow_once", "deny"],
          reason: "NanoGPT tool confirmation is enabled for this turn.",
          subject: { kind: "tool_use", itemId: callId, tool, presentation },
        },
      } });
    } catch {
      finish(false);
    }
  });
}

/**
 * Asks bb to run a tool. The returned promise always settles: either bb
 * answers, or the turn is aborted and the pending entry is removed.
 */
async function requestToolCall(
  session: Session,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  source: ToolCallSource,
  controls: ToolControls,
): Promise<{ content: string; isError: boolean }> {
  if (signal.aborted) {
    return Promise.resolve(CANCELLED_TOOL_REPLY);
  }
  const rejection = toolRejection(session, tool, source, controls);
  if (rejection !== null) {
    return Promise.resolve({
      content: rejection,
      isError: true,
    });
  }
  if (source === "model" && controls.confirmToolCalls) {
    const denied = await requestToolApproval(session, callId, tool, args, signal);
    if (signal.aborted || sessions.get(session.threadId) !== session) return CANCELLED_TOOL_REPLY;
    if (denied !== null) return denied;
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

function estimatedUsage(inputTokens: number, outputTokens: number): ThreadEventTokenUsageBreakdown {
  return {
    ...ZERO_TOKEN_USAGE,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function abortError(): DOMException {
  return new DOMException("Turn aborted", "AbortError");
}

function newActiveTurn(): ActiveTurn {
  return {
    clientRequestId: null,
    controller: new AbortController(),
    done: Promise.resolve(),
    settled: false,
    reasoningKey: null,
    messageKey: null,
    messageText: "",
    historyStart: null,
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
  const providerCheckpointId = encodeContextCheckpoint({
    requestId: turn.clientRequestId,
    inputRetained: turn.historyStart !== null && session.messages.length > turn.historyStart,
  });
  if (turn.historyStart !== null && session.messages.length > turn.historyStart) {
    session.completedTurnEnds.push(session.messages.length);
  }
  if (outcome.status === "completed") {
    session.usageTotal = addTokenUsage(session.usageTotal, outcome.usage);
    deltas.push(
      {
        kind: "usage",
        total: session.usageTotal,
        last: outcome.usage,
        modelContextWindow: null,
      },
      { kind: "turn.boundary", status: "completed", providerCheckpointId },
    );
  } else if (outcome.status === "interrupted") {
    deltas.push({ kind: "turn.boundary", status: "interrupted", providerCheckpointId });
  } else {
    deltas.push(
      { kind: "provider.error", message: outcome.message },
      {
        kind: "turn.boundary",
        status: "failed",
        providerCheckpointId,
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
      if (session.activeTurn === activeTurn && sessions.get(session.threadId) === session) {
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
  turn.clientRequestId = args.clientRequestId ?? null;
  session.turnCounter += 1;

  // Nothing may be emitted once the turn has settled (for example after a
  // stop): the terminal boundary has already been sent.
  const emit = (deltas: ThreadDelta[]): void => {
    if (!turn.settled && sessions.get(threadId) === session) {
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

  let historyMark = session.messages.length;
  let hasModelProgress = false;
  // Usage is summed over every model round of the turn.
  let turnUsage: ThreadEventTokenUsageBreakdown = ZERO_TOKEN_USAGE;
  let requestBaseUrl = "";
  let reasoningEffort: NanoGptReasoningEffort | undefined;

  try {
    const model = modelId(args.options);
    const reasoningSelection = resolveReasoningSelection(args.options.reasoningLevel);
    const providerOptions = nanoGptProviderOptionsSchema.partial().parse(args.options.providerOptions);
    requestBaseUrl = baseUrl(args.options.providerOptions, args.options.envVars);
    const client = createNanoGptClient({ baseUrl: requestBaseUrl, apiKey: key });
    if (reasoningSelection.kind === "explicit") {
      const cacheKey = modelCatalogCacheKey(requestBaseUrl, key);
      const hadCachedEntry = modelCatalogCache.has(cacheKey) && modelCatalogCache.get(cacheKey)!.expiresAt > Date.now();
      let catalog = await modelCatalog(client, requestBaseUrl, key, signal);
      try {
        assertModelEffort(reasoningSelection, catalog.get(model));
      } catch (err) {
        // Cached catalog doesn't support the explicit effort; try one bounded refresh
        // only if we originally hit the cache (to avoid double-fetch on cold start).
        if (hadCachedEntry) {
          catalog = await modelCatalog(client, requestBaseUrl, key, signal, true);
          assertModelEffort(reasoningSelection, catalog.get(model));
        } else {
          throw err;
        }
      }
      reasoningEffort = reasoningSelection.effort;
    }
    const planMode = providerOptions.promptMode === "plan";
    setSystemMessage(session, args.options, planMode);
    if (session.restorationRequired) {
      await restoreSessionHistory(session, args.clientRequestId, signal, toolControlsSchema.parse(args.options.providerOptions ?? {}));
      if (turn.settled || signal.aborted) throw abortError();
    }
    historyMark = session.messages.length;
    turn.historyStart = historyMark;
    const content = await userContent(args.input, signal);
    if (turn.settled || signal.aborted) throw abortError();
    session.messages.push({ role: "user", content });
    const controls = toolControlsSchema.parse(args.options.providerOptions ?? {});
    const tools = planMode ? [] : toolDefinitions(session, controls);
    let rounds = 0;
    while (true) {
      rounds += 1;
      if (rounds > MAX_TOOL_ROUNDS) {
        throw new NanoGptApiError({
          status: 0,
          message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`,
        });
      }
      const context = fitContext(session.messages, session.completedTurnEnds, historyMark, tools);
      historyMark = context.currentStart;
      turn.historyStart = historyMark;
      if (context.removedTurns > 0) {
        const key = { providerItemId: itemId(session, "context-notice", rounds) };
        emit([
          { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
          { kind: "item.textClose", key, channel: "agentMessage", text: `Older conversation context was removed to fit the local token budget (${context.removedTurns} turn(s)). The visible conversation is unchanged.` },
        ]);
      }

      const stream = client.streamChatCompletion({
        model,
        messages: session.messages,
        tools: tools.length > 0 ? tools : undefined,
        reasoningEffort,
        signal,
      });

      let sawFinal = false;
      let finalContent = "";
      let finalToolCalls: NanoGptToolCall[] = [];
      let finalUsage: ThreadEventTokenUsageBreakdown | null = null;
      let finishReason: string | null = null;
      let reasoningTokens = 0;

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
          reasoningTokens += estimateTextTokens(event.text);
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
      if (finalContent !== "") {
        hasModelProgress = true;
      }
      closeRoundText(session, turn, finalContent);
      const outputTokens = estimateTextTokens(finalContent) + reasoningTokens + (finalToolCalls.length === 0 ? 0 : estimateTextTokens(JSON.stringify(finalToolCalls)));
      turnUsage = addTokenUsage(turnUsage, finalUsage ?? estimatedUsage(context.inputTokens, outputTokens));

      if (finishReason === "length" || finishReason === "content_filter" || (planMode && finalToolCalls.length > 0)) {
        // The model hit its output limit: the text, and any tool-call
        // arguments, are cut off. Keep what the user saw, but never present
        // it as a finished answer and never run a half-written tool call.
        if (finalContent !== "") {
          session.messages.push({ role: "assistant", content: boundedHistoryText(finalContent) });
        }
        throw new NanoGptApiError({
          status: 0,
          message:
            finishReason === "content_filter"
              ? "The provider blocked this response. No tool calls from this response were run."
              : planMode && finalToolCalls.length > 0
                ? "The model returned a tool call in plan mode. No tools were run. Switch out of plan mode to execute actions."
                : "The model stopped because it reached its output length limit, so the answer is incomplete. Ask it to continue, or choose a model with a larger output limit.",
        });
      }

      if (finalToolCalls.length === 0) {
        session.messages.push({ role: "assistant", content: boundedHistoryText(finalContent) });
        break;
      }

      session.messages.push({
        role: "assistant",
        content: finalContent === "" ? null : boundedHistoryText(finalContent),
        tool_calls: finalToolCalls,
      });
      hasModelProgress = true;
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
          "model",
          controls,
        );
        if (signal.aborted || turn.settled || sessions.get(threadId) !== session) {
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
          content: boundedHistoryText(reply.content === "" ? "OK" : reply.content),
        });
        markAnswered(call.id);
      }
    }

    settleTurn(session, turn, { status: "completed", usage: turnUsage });
  } catch (error) {
    if (turn.settled) return;
    if (reasoningEffort !== undefined && error instanceof NanoGptApiError &&
        error.status === 400 && /reason|effort|thinking/i.test(error.message)) {
      invalidateModelCatalog(requestBaseUrl, key);
    }
    if (turn.messageText !== "") {
      session.messages.push({ role: "assistant", content: boundedHistoryText(turn.messageText) });
      hasModelProgress = true;
    }
    const aborted =
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError");
    if (aborted) {
      settleTurn(session, turn, { status: "interrupted" });
      return;
    }
    const discardedInput = !hasModelProgress;
    if (discardedInput) session.messages.length = historyMark;
    const detail = error instanceof Error ? error.message : String(error);
    settleTurn(session, turn, {
      status: "failed",
      message: detail + (discardedInput ? INPUT_NOT_RETAINED_NOTICE : ""),
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
  // Maintenance requests carry no current credentials. bb overlays this
  // baseline with the server's experimental_contributeEnvHealth result.
  // Reading process.env here would report stale authentication after key edits.
  return {
    supported: true,
    health: {
      status: "unauthenticated",
      statusMessage:
        "Paste your NanoGPT API key into the NanoGPT provider plugin settings to use NanoGPT.",
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

function turnOptionsOf(options: BridgeExecutionOptions): TurnOptions {
  // The SDK has validated the full policy tuple. Retain its scalar fields in an
  // immutable per-request snapshot, including when the request is queued.
  return Object.freeze({
    ...options,
    providerOptions: structuredClone(options.providerOptions ?? {}),
    envVars: options.envVars === undefined ? undefined : { ...options.envVars },
  });
}

function acceptsPermissionPolicy(id: JsonRpcId, options: BridgeExecutionOptions): boolean {
  const message = unsupportedPermissionPolicy(options);
  if (message !== null) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message);
    return false;
  }
  const controls = toolControlsSchema.safeParse(options.providerOptions ?? {});
  if (!controls.success) {
    invalidParams(id, "tool controls", controls.error.issues);
    return false;
  }
  return true;
}

function sessionTools(id: JsonRpcId, definitions: readonly DynamicTool[] | undefined): ReadonlyMap<string, DynamicTool> | null {
  const tools = new Map<string, DynamicTool>();
  for (const tool of definitions ?? []) {
    if (tools.has(tool.name)) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Duplicate dynamic tool name "${tool.name}".`);
      return null;
    }
    tools.set(tool.name, tool);
  }
  return tools;
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
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
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
        const requestBaseUrl = baseUrl(undefined, parsed.data.envVars);
        const client = createNanoGptClient({
          baseUrl: requestBaseUrl,
          apiKey: key,
        });
        const catalog = await modelCatalog(client, requestBaseUrl, key, undefined, true);
        const ids = [...catalog.keys()];
        const preferred = new Map(
          NANO_GPT_FALLBACK_MODELS.map((model, index) => [model.id, index]),
        );
        const unique = [...new Set(ids)];
        unique.sort((left, right) => {
          return ((preferred.get(left) ?? Infinity) - (preferred.get(right) ?? Infinity)) || left.localeCompare(right);
        });
        const defaultId = unique.includes(NANO_GPT_DEFAULT_MODEL_ID) ? NANO_GPT_DEFAULT_MODEL_ID : unique[0];
        const models = unique.map((id) => {
          const entry = catalog.get(id);
          const options = reasoningOptions(catalogEfforts(entry));
          return {
            id,
            model: id,
            displayName: modelDisplayName(id),
            description: "Chat model routed through NanoGPT.",
            // The plugin always offers a complete, authoritative option set: when
            // NanoGPT omits or malforms `reasoning_efforts`, only Provider default
            // is offered. Reporting "known" stops bb's catalog store from keeping
            // stale explicit options that the current catalog no longer verifies.
            reasoningDiscovery: "known" as const,
            supportedReasoningEfforts: options.map(({ reasoningEffort, label, description }) => ({ reasoningEffort, label, description })),
            defaultReasoningEffort: options[0]!.reasoningEffort,
            isDefault: id === defaultId,
          };
        });
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
    if (!acceptsPermissionPolicy(id, parsed.data.options)) return;
    const tools = sessionTools(id, parsed.data.dynamicTools);
    if (tools === null) return;
    threadCounter += 1;
    const providerThreadId = `nano_gpt_${instanceNonce}_${threadCounter}`;
    const session = openSession({
      threadId: parsed.data.threadId,
      providerThreadId,
      cwd: parsed.data.cwd,
      tools,
      disallowedTools: parsed.data.disallowedTools,
      restorationRequired: false,
    });
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
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
    if (!acceptsPermissionPolicy(id, parsed.data.options)) return;
    const tools = sessionTools(id, parsed.data.dynamicTools);
    if (tools === null) return;
    openSession({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      cwd: parsed.data.cwd,
      tools,
      disallowedTools: parsed.data.disallowedTools,
      restorationRequired: true,
    });
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: true,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    if (!acceptsPermissionPolicy(id, parsed.data.options)) return;
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
    if (!acceptsPermissionPolicy(id, parsed.data.options)) return;
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
    if (parsed.data.intent === "interrupt") {
      if (activeTurn === null) {
        io.sendResult(id, {});
        return;
      }
      activeTurn.controller.abort();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS);
        timer.unref?.();
      });
      void Promise.race([activeTurn.done, timeout]).then(() => {
        clearTimeout(timer);
        // If the turn did not settle in time (for example a hung request),
        // settle it here so an interrupt always ends in an interrupted
        // boundary. This is a no-op when the turn already settled.
        settleTurn(session, activeTurn, { status: "interrupted" });
        if (sessions.get(session.threadId) === session && session.activeTurn === activeTurn) {
          session.activeTurn = null;
          drainQueue(session);
        }
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
  const approval = pendingApprovals.get(parsed.data.id);
  if (approval !== undefined) {
    approval.resolve(parsed.data.error === undefined && toolApprovalAllowed(parsed.data.result));
    return;
  }
  const pending = pendingToolCalls.get(parsed.data.id);
  if (pending === undefined) {
    if (process.env.NANOGPT_DEBUG_BRIDGE === "1") {
      console.error("NanoGPT bridge: ignored a late or unmatched tool response.");
    }
    return;
  }
  pendingToolCalls.delete(parsed.data.id);
  if (sessions.get(pending.session.threadId) !== pending.session) {
    pending.resolve(CANCELLED_TOOL_REPLY);
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




