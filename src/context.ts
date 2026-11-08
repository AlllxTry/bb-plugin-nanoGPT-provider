import type { NanoGptMessage, NanoGptToolDefinition } from "./nano-gpt-client.js";

// Local fallback policy, not a claim about any routed model's context window.
export const CONTEXT_WINDOW_BUDGET = 32_768;
export const RESERVED_OUTPUT_TOKENS = 4_096;
export const INPUT_TOKEN_BUDGET = CONTEXT_WINDOW_BUDGET - RESERVED_OUTPUT_TOKENS;
export const MAX_STORED_TEXT_BYTES = 24_000;

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

/** Keep valid whole turns. Reject an oversized current turn without evicting anything. */
export function fitContext(messages: NanoGptMessage[], completedEnds: number[], currentStart: number, tools: readonly NanoGptToolDefinition[], budget = INPUT_TOKEN_BUDGET): { currentStart: number; inputTokens: number; removedTurns: number } {
  const systemCount = messages[0]?.role === "system" ? 1 : 0;
  let removedTurns = 0;
  let firstRetained = systemCount;
  let inputTokens = estimateInputTokens(messages, tools);
  while (inputTokens > budget && removedTurns < completedEnds.length) {
    const end = completedEnds[removedTurns];
    if (end === undefined || end > currentStart) break;
    firstRetained = end;
    removedTurns++;
    inputTokens = estimateInputTokens([...messages.slice(0, systemCount), ...messages.slice(firstRetained)], tools);
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
