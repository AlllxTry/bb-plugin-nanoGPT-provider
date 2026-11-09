import { describe, expect, it } from "vitest";
import { restoreNanoGptHistory } from "./history-adapter.js";
import { fitContext } from "./context.js";
import { encodeContextCheckpoint, INPUT_NOT_RETAINED_NOTICE } from "./history-protocol.js";

const row = (seq: number, type: string, data: unknown, scope: unknown = {}) => ({
  seq,
  type,
  data,
  scope,
});

describe("restoreNanoGptHistory", () => {
  it("reconstructs accepted turns and normalized tool interactions in order", () => {
    const restored = restoreNanoGptHistory([
      row(1, "client/turn/requested", {
        requestId: "req-old", initiator: "user",
        input: [{ type: "text", text: "read it" }],
      }),
      row(2, "turn/input/accepted", { clientRequestId: "req-old" }, { kind: "turn", turnId: "turn-1" }),
      row(3, "turn/started", {}, { kind: "turn", turnId: "turn-1" }),
      row(4, "item/completed", { item: { id: "item-call", type: "toolCall", tool: "read_file", arguments: { path: "a" }, result: "contents" } }, { kind: "turn", turnId: "turn-1" }),
      row(5, "item/completed", { item: { id: "item-answer", type: "agentMessage", text: "Done" } }, { kind: "turn", turnId: "turn-1" }),
      row(6, "turn/completed", { status: "completed" }, { kind: "turn", turnId: "turn-1" }),
    ]);

    expect(restored.messages).toEqual([
      { role: "user", content: "read it" },
      {
        role: "assistant", content: null,
        tool_calls: [{ id: "bb_6974656d2d63616c6c", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
      },
      { role: "tool", tool_call_id: "bb_6974656d2d63616c6c", content: "contents" },
      { role: "assistant", content: "Done" },
    ]);
    expect(restored.completedTurnEnds).toEqual([4]);
    expect(restored.throughSeq).toBe(6);
  });

  it("filters rejected, current, cleared, and bootstrap history", () => {
    const restored = restoreNanoGptHistory([
      row(1, "client/turn/requested", { requestId: "old", initiator: "user", input: [{ type: "text", text: "before clear" }] }),
      row(2, "thread/context/cleared", {}),
      row(3, "client/turn/requested", { requestId: "rejected", initiator: "user", input: [{ type: "text", text: "rejected" }] }),
      row(6, "client/turn/requested", { requestId: "current", initiator: "user", input: [{ type: "text", text: "current" }] }),
      row(7, "turn/input/accepted", { clientRequestId: "current" }, { kind: "turn", turnId: "t2" }),
      row(8, "item/completed", { item: { id: "bootstrap", type: "toolCall", tool: "nanogpt_restore_history", arguments: {} } }, { kind: "turn", turnId: "t2" }),
    ], { currentRequestId: "current" });

    expect(restored.messages).toEqual([]);
    expect(restored.completedTurnEnds).toEqual([]);
  });

  const scope = (turnId: string) => ({ kind: "turn", turnId });
  const prompt = (seq: number, requestId: string, text: string, extra = {}) => row(seq, "client/turn/requested", {
    requestId, initiator: "user", input: [{ type: "text", text }], ...extra,
  });
  const accept = (seq: number, requestId: string, turnId: string) => row(seq, "turn/input/accepted", { clientRequestId: requestId }, scope(turnId));
  const answer = (seq: number, turnId: string, text: string) => row(seq, "item/completed", {
    item: { id: `answer-${seq}`, type: "agentMessage", text },
  }, scope(turnId));
  const end = (seq: number, turnId: string, status: string, checkpoint?: { requestId: string; inputRetained: boolean }) => row(seq, "turn/completed", {
    status, ...(checkpoint === undefined ? {} : { providerCheckpointId: encodeContextCheckpoint(checkpoint) }),
  }, scope(turnId));

  it("restores the accepted retry when the original request never entered context", () => {
    const restored = restoreNanoGptHistory([
      prompt(1, "original", "question"),
      prompt(2, "retry", "question", { retryOfRequestId: "original" }),
      accept(3, "retry", "t"), answer(4, "t", "answer"), end(5, "t", "completed"),
    ]);
    expect(restored.messages).toEqual([{ role: "user", content: "question" }, { role: "assistant", content: "answer" }]);
  });

  it("preserves continuation input from an accepted retry exactly once", () => {
    const restored = restoreNanoGptHistory([
      prompt(1, "original", "question"), accept(2, "original", "t1"), answer(3, "t1", "partial"), end(4, "t1", "failed"),
      prompt(5, "retry", "Please continue.", { retryOfRequestId: "original" }),
      accept(6, "retry", "t2"), answer(7, "t2", "answer"), end(8, "t2", "completed"),
    ]);
    expect(restored.messages.map((message) => message.content)).toEqual(["question", "partial", "Please continue.", "answer"]);
  });

  it.each([false, true])("restores queued input after the tool round (checkpoint=%s)", (checkpoint) => {
    const tool = (seq: number) => row(seq, "item/completed", { item: { id: `call-${seq}`, type: "toolCall", tool: "read_file", arguments: {}, result: "data" } }, scope("t1"));
    const restored = restoreNanoGptHistory([
      prompt(1, "first", "read"), accept(2, "first", "t1"), tool(3),
      prompt(4, "queued", "followup"), accept(5, "queued", "t1"), tool(6), answer(7, "t1", "done"),
      end(8, "t1", "completed", checkpoint ? { requestId: "first", inputRetained: true } : undefined),
      row(9, "turn/started", {}, scope("t2")), answer(10, "t2", "followup answer"),
      end(11, "t2", "completed", checkpoint ? { requestId: "queued", inputRetained: true } : undefined),
    ]);
    expect(restored.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "user", "assistant"]);
    expect(restored.messages[5]?.content).toBe("followup");
    expect(restored.completedTurnEnds).toEqual([5, 7]);
  });

  it("does not restore a queued input canceled before execution", () => {
    const restored = restoreNanoGptHistory([
      prompt(1, "first", "read"), accept(2, "first", "t1"),
      prompt(3, "queued", "never executed"), accept(4, "queued", "t1"),
      answer(5, "t1", "partial"), end(6, "t1", "interrupted", { requestId: "first", inputRetained: true }),
      prompt(7, "next", "next"), accept(8, "next", "t2"), answer(9, "t2", "answer"),
      end(10, "t2", "completed", { requestId: "next", inputRetained: true }),
    ]);
    expect(restored.messages.map((message) => message.content)).toEqual(["read", "partial", "next", "answer"]);
  });

  it.each([false, true])("does not resurrect oversized failed input (checkpoint=%s)", (checkpoint) => {
    const restored = restoreNanoGptHistory([
      prompt(1, "bad", "x".repeat(100000)), accept(2, "bad", "t"),
      // A checkpoint is authoritative even when bb displays a context notice.
      ...(checkpoint ? [answer(3, "t", "Older conversation context was removed")] : []),
      end(4, "t", "failed", checkpoint ? { requestId: "bad", inputRetained: false } : undefined),
    ]);
    expect(restored.messages).toEqual([]);
    restored.messages.push({ role: "user", content: "small" });
    expect(() => fitContext(restored.messages, restored.completedTurnEnds, 0, [])).not.toThrow();
  });

  it.each(["failed", "interrupted"])("evicts a retained %s turn as a whole", (status) => {
    const restored = restoreNanoGptHistory([
      prompt(1, "r", "old"), accept(2, "r", "t"), answer(3, "t", "partial".repeat(100)), end(4, "t", status),
    ]);
    expect(restored.completedTurnEnds).toEqual([2]);
    restored.messages.push({ role: "user", content: "small" });
    expect(fitContext(restored.messages, restored.completedTurnEnds, 2, [], 30).removedTurns).toBe(1);
    expect(restored.messages).toEqual([{ role: "user", content: "small" }]);
  });

  it("honors the legacy rollback notice even when a display notice was emitted", () => {
    const restored = restoreNanoGptHistory([
      prompt(1, "bad", "discarded"), accept(2, "bad", "t"),
      answer(3, "t", "Older conversation context was removed"),
      row(4, "turn/completed", { status: "failed", error: { message: "API error." + INPUT_NOT_RETAINED_NOTICE } }, scope("t")),
    ]);
    expect(restored.messages).toEqual([]);
    expect(restored.completedTurnEnds).toEqual([]);
  });

  it("restores supported attachments and marks missing local files", () => {
    const restored = restoreNanoGptHistory([
      row(1, "client/turn/requested", { requestId: "r", initiator: "user", input: [
        { type: "text", text: "look" },
        { type: "image", url: "https://example.test/image.png" },
        { type: "localFile", path: "C:\\secret\\report.pdf" },
      ] }),
      row(2, "turn/input/accepted", { clientRequestId: "r" }, { kind: "turn", turnId: "t" }),
    ]);
    expect(restored.messages[0]).toEqual({ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } },
      { type: "text", text: "[Historical file attachment unavailable: report.pdf]" },
    ] });
  });
});
