import { describe, expect, it } from "vitest";
import {
  boundedHistoryText,
  estimateInputTokens,
  fitContext,
  inputTokenBudgetFor,
  INPUT_TOKEN_BUDGET,
} from "./context.js";
import type { NanoGptMessage } from "./nano-gpt-client.js";

describe("context budgeting", () => {
  it("uses the catalog context window and falls back to the local budget", () => {
    expect(inputTokenBudgetFor(131_072)).toBe(131_072 - 4_096);
    expect(inputTokenBudgetFor(null)).toBe(INPUT_TOKEN_BUDGET);
    expect(inputTokenBudgetFor(undefined)).toBe(INPUT_TOKEN_BUDGET);
    expect(inputTokenBudgetFor(0)).toBe(INPUT_TOKEN_BUDGET);
    // A window smaller than the reserve still leaves a usable minimum.
    expect(inputTokenBudgetFor(2_000)).toBe(1_024);
    // The local fallback applies to absurd advertised windows, not the
    // upstream value.
    expect(inputTokenBudgetFor(Number.MAX_SAFE_INTEGER)).toBe(INPUT_TOKEN_BUDGET);
  });

  it("compacts old tool results inside the current turn before rejecting", () => {
    const messages: NanoGptMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(24_000) },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "y".repeat(24_000) },
    ];
    // A tight budget that the raw tool replies exceed, but their compacted
    // forms fit: compaction must shorten them in place instead of throwing.
    const rawTokens = estimateInputTokens(messages);
    const budget = Math.ceil(rawTokens * 0.9);
    expect(budget).toBeLessThan(rawTokens);
    const result = fitContext(messages, [], 1, [], budget);
    expect(result.inputTokens).toBeLessThanOrEqual(budget);
    // Compaction shortens the oldest oversized tool reply first and stops as
    // soon as the messages fit; both tool-call pairs stay intact so the
    // message history remains valid.
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect((messages[3] as { content: string }).content).toContain("shortened to fit");
    expect((messages[5] as { content: string }).content).toContain("y".repeat(100));
  });

  it("still rejects a current turn that cannot fit even after compaction", () => {
    const messages: NanoGptMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "x".repeat(120_000) },
    ];
    expect(() => fitContext(messages, [], 1, [])).toThrow(/exceeds the local context budget/);
  });
  it("evicts whole tool turns while preserving the system and current turn", () => {
    const system: NanoGptMessage = { role: "system", content: "system" };
    const current: NanoGptMessage = { role: "user", content: "current" };
    const messages: NanoGptMessage[] = [system, { role: "user", content: "old" }, { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call", content: "x".repeat(1000) }, { role: "assistant", content: "done" }, current];
    const ends = [5];
    expect(fitContext(messages, ends, 5, [], 50)).toMatchObject({ currentStart: 1, removedTurns: 1 });
    expect(messages).toEqual([system, current]);
    expect(ends).toEqual([]);
  });
  it("rejects oversized current input without deleting prior useful context", () => {
    const messages: NanoGptMessage[] = [{ role: "system", content: "system" }, { role: "user", content: "old" }, { role: "assistant", content: "answer" }, { role: "user", content: "x".repeat(1000) }];
    const original = structuredClone(messages);
    const ends = [3];
    expect(() => fitContext(messages, ends, 3, [], 50)).toThrow(/current turn exceeds/);
    expect(messages).toEqual(original);
    expect(ends).toEqual([3]);
  });
  it("counts multipart text, tool payloads and images without counting base64 characters", () => {
    const small: NanoGptMessage[] = [{ role: "user", content: [{ type: "text", text: "text" }, { type: "image_url", image_url: { url: "data:image/png;base64,a" } }] }];
    const large = structuredClone(small);
    (large[0] as { content: { image_url?: { url: string } }[] }).content[1]!.image_url!.url += "a".repeat(100000);
    expect(estimateInputTokens(large)).toBe(estimateInputTokens(small));
    expect(estimateInputTokens(small)).toBeGreaterThan(2048);
    expect(estimateInputTokens([{ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "tool", arguments: '{"data":"long"}' } }] }])).toBeGreaterThan(8);
    expect(estimateInputTokens([], [{ type: "function", function: { name: "tool", description: "text", parameters: {} } }])).toBeGreaterThan(0);
  });
  it("bounds stored outputs without splitting UTF-8 and keeps both ends", () => {
    const text = boundedHistoryText("start " + "é中".repeat(300) + " end", 200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    expect(text).toContain("Output truncated");
    expect(text).not.toContain("�");
    expect(text.startsWith("start ")).toBe(true);
    expect(text.endsWith(" end")).toBe(true);
  });
});
