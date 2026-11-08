import { describe, expect, it } from "vitest";
import { boundedHistoryText, estimateInputTokens, fitContext } from "./context.js";
import type { NanoGptMessage } from "./nano-gpt-client.js";

describe("context budgeting", () => {
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
