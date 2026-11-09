import { basename } from "node:path";
import type {
  NanoGptContentPart,
  NanoGptMessage,
  NanoGptToolCall,
} from "./nano-gpt-client.js";
import { boundedHistoryText } from "./context.js";
import { decodeContextCheckpoint, HISTORY_TOOL_NAME, INPUT_NOT_RETAINED_NOTICE } from "./history-protocol.js";
import { z } from "zod";

type JsonRecord = Record<string, unknown>;

export interface HistoryEventRow {
  seq: number;
  scope?: unknown;
  type: string;
  data: unknown;
}

export interface RestoredHistory {
  messages: NanoGptMessage[];
  completedTurnEnds: number[];
  throughSeq: number;
}

const historyEventRowSchema = z.object({
  seq: z.number().int().nonnegative(),
  scope: z.unknown().optional(),
  type: z.string(),
  data: z.unknown(),
});

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function contentInput(value: unknown): NanoGptContentPart | string | null {
  const input = record(value);
  if (input?.type === "text" && typeof input.text === "string") {
    return { type: "text", text: input.text };
  }
  if (input?.type === "image" && typeof input.url === "string") {
    return { type: "image_url", image_url: { url: input.url } };
  }
  if (
    (input?.type === "localImage" || input?.type === "localFile") &&
    typeof input.path === "string"
  ) {
    return {
      type: "text",
      text: `[Historical ${input.type === "localImage" ? "image" : "file"} attachment unavailable: ${basename(input.path.replaceAll("\\", "/"))}]`,
    };
  }
  return null;
}

function userMessage(input: unknown): NanoGptMessage["content"] | null {
  const prompt = record(input);
  if (prompt === null || !Array.isArray(prompt.input)) return null;
  const content = prompt.input.map(contentInput);
  if (content.some((part) => part === null)) return null;
  const parts = content as (NanoGptContentPart | string)[];
  if (parts.every((part) => typeof part === "string" || part.type === "text")) {
    return parts.map((part) => typeof part === "string"
      ? part
      : part.type === "text" ? part.text : "").join("");
  }
  return parts.map((part) => typeof part === "string"
    ? { type: "text" as const, text: part }
    : part);
}

function toolCallId(itemId: string): string {
  return `bb_${Buffer.from(itemId, "utf8").toString("hex")}`;
}

function orderedRows(rows: readonly unknown[]): HistoryEventRow[] {
  const parsed = rows.map((row) => {
    const result = historyEventRowSchema.safeParse(row);
    if (!result.success) throw new Error("bb history contains a malformed event row.");
    return result.data;
  });
  return parsed
    .sort((left, right) => left.seq - right.seq);
}

export function restoreNanoGptHistory(
  inputRows: readonly unknown[],
  options: { currentRequestId?: string } = {},
): RestoredHistory {
  const rows = orderedRows(inputRows);
  const throughSeq = rows.at(-1)?.seq ?? 0;
  const clearSeq = rows.reduce((latest, row) => {
    const data = record(row.data);
    return (
      row.type === "thread/context/cleared" ||
      (row.type === "system/operation" &&
        data?.operation === "context_clear" &&
        data.status === "completed")
    )
      ? Math.max(latest, row.seq)
      : latest;
  }, -1);

  const accepted = new Set<string>();
  const requests = new Map<string, JsonRecord>();
  const turns = new Map<string, { rows: HistoryEventRow[]; accepted: string[] }>();
  for (const row of rows) {
    if (row.seq <= clearSeq) continue;
    const data = record(row.data);
    const scope = record(row.scope);
    if (row.type === "client/turn/requested" && typeof data?.requestId === "string") {
      requests.set(data.requestId, data);
    }
    if (scope?.kind !== "turn" || typeof scope.turnId !== "string") continue;
    let turn = turns.get(scope.turnId);
    if (turn === undefined) {
      turn = { rows: [], accepted: [] };
      turns.set(scope.turnId, turn);
    }
    turn.rows.push(row);
    if (row.type === "turn/input/accepted" && typeof data?.clientRequestId === "string") {
      accepted.add(data.clientRequestId);
      turn.accepted.push(data.clientRequestId);
    }
  }

  const messages: NanoGptMessage[] = [];
  const completedTurnEnds: number[] = [];
  const seenItems = new Set<string>();
  const seenCalls = new Set<string>();
  const restoredRequests = new Set<string>();
  let pendingLegacyInputs: string[] = [];

  // Keep every turn together: request timestamps describe submission, and a
  // steer may be accepted in one turn but executed in the next one.
  for (const turn of turns.values()) {
    const terminal = turn.rows.filter((row) => row.type === "turn/completed").at(-1);
    const terminalData = record(terminal?.data);
    const checkpoint = decodeContextCheckpoint(terminalData?.providerCheckpointId);
    let requestId: string | null | undefined;
    if (checkpoint !== null) {
      requestId = checkpoint.requestId;
      pendingLegacyInputs = pendingLegacyInputs.filter((id) => id !== requestId);
    } else if (turn.accepted.length > 0) {
      // Older logs have no execution checkpoint. Their first acceptance is
      // the turn input; additional acceptances are queued steers.
      requestId = turn.accepted[0];
      pendingLegacyInputs = [];
    } else {
      requestId = pendingLegacyInputs.shift();
    }
    pendingLegacyInputs.push(...turn.accepted.filter((id) => id !== requestId));
    if (terminalData?.status === "interrupted") pendingLegacyInputs = [];

    if (requestId === options.currentRequestId && requestId !== undefined) continue;
    const hasProgress = turn.rows.some((row) => {
      if (row.type !== "item/completed") return false;
      const item = record(record(row.data)?.item);
      return (item?.type === "agentMessage" && typeof item.text === "string" && item.text !== "") ||
        (item?.type === "toolCall" && item.tool !== HISTORY_TOOL_NAME);
    });
    // Before checkpoints existed the bridge also rolled back failed input
    // without model progress. Infer that case from the normalized items.
    const legacyError = record(terminalData?.error)?.message;
    const legacyRollback = typeof legacyError === "string" && legacyError.endsWith(INPUT_NOT_RETAINED_NOTICE);
    if (checkpoint?.inputRetained === false ||
      (checkpoint === null && terminalData?.status === "failed" && (legacyRollback || !hasProgress))) continue;
    const turnStart = messages.length;
    if (typeof requestId === "string" && accepted.has(requestId) && !restoredRequests.has(requestId)) {
      const request = requests.get(requestId);
      const content = userMessage(request);
      if (content !== null) {
        messages.push({ role: "user", content });
        restoredRequests.add(requestId);
      }
    }

    let assistant: Extract<NanoGptMessage, { role: "assistant" }> | undefined;
    for (const row of turn.rows) {
      const data = record(row.data);
      if (data === null) continue;
      if (row.type !== "item/completed") continue;
      const item = record(data.item);
      if (item === null || typeof item.id !== "string" || seenItems.has(item.id)) continue;
      seenItems.add(item.id);

      if (item.type === "agentMessage" && typeof item.text === "string") {
        assistant = { role: "assistant", content: boundedHistoryText(item.text) };
        messages.push(assistant);
        continue;
      }

      if (
        item.type !== "toolCall" ||
        typeof item.tool !== "string" ||
        item.tool === HISTORY_TOOL_NAME ||
        seenCalls.has(item.id)
      ) continue;
      seenCalls.add(item.id);

      if (assistant === undefined) {
        assistant = { role: "assistant", content: null };
        messages.push(assistant);
      }
      const callId = toolCallId(item.id);
      const args = record(item.arguments) ?? {};
      const call: NanoGptToolCall = {
        id: callId,
        type: "function",
        function: { name: item.tool, arguments: JSON.stringify(args) },
      };
      assistant.tool_calls = [...(assistant.tool_calls ?? []), call];

      const result = typeof item.result === "string"
        ? item.result
        : typeof item.error === "string"
          ? `Tool failed: ${item.error}`
          : item.status === "interrupted" || item.status === "pending"
            ? "Tool was interrupted; its result was not recorded."
            : "Tool result was not recorded in bb history.";
      const truncation = record(item.truncation);
      const content = truncation?.result === undefined
        ? result
        : `${result}\n[bb retained only a preview of this historical tool result.]`;
      messages.push({ role: "tool", tool_call_id: callId, content: boundedHistoryText(content) });
    }
    if (terminal !== undefined && messages.length > turnStart) completedTurnEnds.push(messages.length);
  }

  return { messages, completedTurnEnds, throughSeq };
}
