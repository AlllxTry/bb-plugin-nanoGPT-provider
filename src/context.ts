import type { NanoGptMessage, NanoGptToolDefinition } from "./nano-gpt-client.js";

/** Hard upper bound for a catalog-advertised context window we will trust. */
export const MAX_CATALOG_CONTEXT_TOKENS = 10_000_000;

// Local fallback policy, not a claim about any routed model's context window.
export const CONTEXT_WINDOW_BUDGET = 32_768;
export const RESERVED_OUTPUT_TOKENS = 4_096;
export const INPUT_TOKEN_BUDGET = CONTEXT_WINDOW_BUDGET - RESERVED_OUTPUT_TOKENS;
export const MAX_STORED_TEXT_BYTES = 24_000;
/** A cached tool result is compacted to this many characters before being dropped outright. */
export const COMPACTED_TOOL_RESULT_CHARS = 2_000;

export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

export function estimateInputTokens(messages: readonly NanoGptMessage[], tools: readonly NanoGptToolDefinition[] = []): number {
  let total = tools.length === 0 ? 0 : estimateTextTokens(JSON.stringify(tools));
  for (const message of messages) {
    total += 8;
    if (typeof message.content === "string") total += estimateTextTokens(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content) total += part.type === "text" ? estimateTextTokens(part.text) : 2_048;
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) total += estimateTextTokens(JSON.stringify(message.tool_calls));
  }
  return total;
}

/**
 * The input budget for a request: the model's advertised context window when
 * the catalog provides a sane one, otherwise the local fallback. A reserved
 * output slice is always subtracted so long answers cannot overflow the window.
 */
export function inputTokenBudgetFor(contextWindow: number | null | undefined): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return INPUT_TOKEN_BUDGET;
  }
  // Only a sane advertised window is trusted: anything outside a plausible
  // model range falls back to the conservative local budget.
  if (contextWindow > MAX_CATALOG_CONTEXT_TOKENS) {
    return INPUT_TOKEN_BUDGET;
  }
  const budget = contextWindow - RESERVED_OUTPUT_TOKENS;
  return budget >= 1024 ? budget : Math.min(INPUT_TOKEN_BUDGET, Math.max(1024, budget));
}

const COMPACT_NOTICE = "\n[An earlier tool result was shortened to fit the context budget.]";

/**
 * Compacts one oversized tool result in place, from oldest to newest, until the
 * messages fit the budget. Completed-turn tool replies inside the current turn
 * are shortened (not dropped) first; whole old turns are evicted only if that
 * is still not enough.
 */
function compactCurrentTurnToolResults(
  messages: NanoGptMessage[],
  currentStart: number,
  tools: readonly NanoGptToolDefinition[],
  budget: number,
): number {
  let inputTokens = estimateInputTokens(messages, tools);
  if (inputTokens <= budget) return inputTokens;
  for (let index = currentStart; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "tool") continue;
    if (estimateTextTokens(message.content) <= COMPACTED_TOOL_RESULT_CHARS / 3) continue;
    const shortened = message.content.slice(0, COMPACTED_TOOL_RESULT_CHARS) + COMPACT_NOTICE;
    const previous = message.content;
    message.content = shortened;
    const next = estimateInputTokens(messages, tools);
    if (next <= budget) {
      return next;
    }
    // Not enough yet: keep the shortened form and continue compacting.
    inputTokens = next;
  }
  return inputTokens;
}

/** Keep valid whole turns. Reject an oversized current turn without evicting anything. */
export function fitContext(messages: NanoGptMessage[], completedEnds: number[], currentStart: number, tools: readonly NanoGptToolDefinition[], budget = INPUT_TOKEN_BUDGET): { currentStart: number; inputTokens: number; removedTurns: number } {
  const systemCount = messages[0]?.role === "system" ? 1 : 0;
  let removedTurns = 0;
  let firstRetained = systemCount;
  // Incremental accounting: subtract the evicted turn's own cost instead of
  // re-estimating the whole array after every eviction.
  let inputTokens = estimateInputTokens(messages, tools);
  while (inputTokens > budget && removedTurns < completedEnds.length) {
    const end = completedEnds[removedTurns]!;
    if (end === undefined || end > currentStart) break;
    inputTokens -= estimateInputTokens(messages.slice(firstRetained, end), []);
    firstRetained = end;
    removedTurns += 1;
  }
  if (inputTokens > budget) {
    // Old turns alone are not enough (or none are evictable): shorten old tool
    // results inside the current turn before rejecting the request outright.
    inputTokens = compactCurrentTurnToolResults(messages, Math.max(firstRetained, systemCount), tools, budget);
  }
  if (inputTokens > budget) throw new Error("The current turn exceeds the local context budget. Reduce attachments, instructions or tool output, or start a smaller request. No unchanged retry was sent.");
  const removedMessages = firstRetained - systemCount;
  if (removedMessages > 0) {
    messages.splice(systemCount, removedMessages);
    completedEnds.splice(0, removedTurns);
    for (let i = 0; i < completedEnds.length; i++) completedEnds[i] = completedEnds[i]! - removedMessages;
  }
  return { currentStart: currentStart - removedMessages, inputTokens, removedTurns };
}

/** Bound stored outputs without cutting JSON tool arguments or UTF-8 characters. */
export function boundedHistoryText(text: string, limit = MAX_STORED_TEXT_BYTES): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const marker = "\n[Output truncated in model history.]\n";
  const half = Math.max(0, Math.floor((limit - Buffer.byteLength(marker)) / 2));
  const head = new TextDecoder().decode(bytes.subarray(0, half), { stream: true });
  let tailStart = bytes.length - half;
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  return head + marker + bytes.subarray(tailStart).toString("utf8");
}
