import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeJsonRpcObject,
  BridgeJsonRpcTestHarness,
  ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./provider-bridge.js";
import { NANO_GPT_API_KEY_ENV, NANO_GPT_PROVIDER_ID } from "./vocabulary.js";

const THREAD_ID = "thr_nano_gpt_test";
const CWD = "/workspace/nano";

const FULL_OPTIONS = {
  model: "openai/gpt-6.1-sol",
  reasoningLevel: "medium",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  envVars: { [NANO_GPT_API_KEY_ENV]: "sk-nano-bridge-test" },
};

const TOOL_DEFINITION = {
  name: "read_file",
  description: "Read a file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.join("")));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

let harness: BridgeJsonRpcTestHarness;
let savedKey: string | undefined;
let fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
let responses: Response[] = [];

beforeEach(() => {
  harness = createBridgeJsonRpcTestHarness(handleLine);
  savedKey = process.env[NANO_GPT_API_KEY_ENV];
  process.env[NANO_GPT_API_KEY_ENV] = "sk-nano-bridge-test";
  fetchCalls = [];
  responses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: unknown) => {
      fetchCalls.push({
        url: String(url),
        body: JSON.parse(String((init as RequestInit).body ?? "{}")),
      });
      const next = responses.shift();
      if (next === undefined) {
        throw new Error("test ran out of scripted responses");
      }
      return next;
    }),
  );
});

afterEach(() => {
  harness.restore();
  if (savedKey === undefined) {
    delete process.env[NANO_GPT_API_KEY_ENV];
  } else {
    process.env[NANO_GPT_API_KEY_ENV] = savedKey;
  }
  vi.unstubAllGlobals();
});

async function request(
  method: string,
  params: BridgeJsonRpcObject,
): Promise<{ result?: unknown; error?: { code: number } }> {
  const id = `req-${method}-${Math.random()}`;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  return response as { result?: unknown; error?: { code: number } };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for bridge output");
}

function deltaNotifications() {
  return harness.messages
    .filter((message) => message.method === "thread/delta")
    .flatMap((message) => (message.params as { deltas: never[] }).deltas);
}

interface BoundaryDelta {
  kind: string;
  status?: string;
  clientRequestId?: string;
  message?: string;
}

function boundary(status: string): boolean {
  return deltaNotifications().some(
    (delta) =>
      (delta as BoundaryDelta).kind === "turn.boundary" &&
      (delta as BoundaryDelta).status === status,
  );
}

async function initialize() {
  const response = await request("initialize", {
    protocolVersion: 2,
    client: { name: "nano-gpt-test", version: "0.0.0" },
    grammarVersions: [3, 3],
  });
  expect(response.error).toBeUndefined();
}

async function startThread(): Promise<string> {
  const response = await request("thread/start", {
    threadId: THREAD_ID,
    cwd: CWD,
    instructionMode: "append",
    dynamicTools: [TOOL_DEFINITION],
    options: FULL_OPTIONS,
  });
  const result = response.result as { providerThreadId: string };
  expect(typeof result.providerThreadId).toBe("string");
  return result.providerThreadId;
}

function toolRoundResponse(
  callId: string,
  args: string,
  usage?: { prompt: number; completion: number },
): Response {
  return sseResponse([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                function: { name: "read_file", arguments: args },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      ...(usage === undefined
        ? {}
        : {
            usage: {
              prompt_tokens: usage.prompt,
              completion_tokens: usage.completion,
              total_tokens: usage.prompt + usage.completion,
            },
          }),
    }),
    "data: [DONE]\n\n",
  ]);
}

function answerResponse(text: string): Response {
  return sseResponse([
    chunk({ choices: [{ delta: { content: text } }] }),
    chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);
}

function deltaMessages() {
  return harness.messages.filter((message) => message.method === "thread/delta");
}

/** True when the sample is non-empty and every notification is for `threadId`. */
function onlyThread(
  messages: readonly { params?: unknown }[],
  threadId: string,
): boolean {
  return (
    messages.length > 0 &&
    messages.every(
      (message) => (message.params as { threadId: string }).threadId === threadId,
    )
  );
}

function toolCallRequests() {
  return harness.messages.filter((m) => m.method === "item/tool/call");
}

function answerToolCall(index: number): void {
  const call = toolCallRequests()[index];
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        success: true,
        contentItems: [{ type: "inputText", text: "x" }],
      },
    }),
  );
}

async function startTurn(text: string, requestId: string, providerThreadId: string) {
  await request("turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text, mentions: [] }],
    clientRequestId: requestId,
    options: FULL_OPTIONS,
  });
}

describe("the NanoGPT bridge", () => {
  it("answers initialize with grammar v3 capabilities", async () => {
    const response = await request("initialize", {
      protocolVersion: 2,
      client: { name: "nano-gpt-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    expect(response.result).toMatchObject({
      protocolVersion: 2,
      capabilities: {
        grammarVersions: [3, 3],
        sessionRestore: false,
        steerMode: "queue",
      },
    });
  });

  it("runs a turn with one tool round and streams the final answer", async () => {
    await initialize();
    responses.push(
      sseResponse([
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"README.md"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
      sseResponse([
        chunk({ choices: [{ delta: { content: "All done." } }] }),
        chunk({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        }),
        "data: [DONE]\n\n",
      ]),
    );

    const providerThreadId = await startThread();
    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "read it", mentions: [] }],
      clientRequestId: "creq_abcdefgh23",
      options: FULL_OPTIONS,
    });

    await waitFor(() =>
      harness.messages.some((message) => message.method === "item/tool/call"),
    );
    const call = harness.messages.find(
      (message) => message.method === "item/tool/call",
    );
    expect(call?.params).toMatchObject({
      providerThreadId,
      threadId: THREAD_ID,
      tool: "read_file",
      arguments: { path: "README.md" },
    });
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call?.id,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "file contents" }],
        },
      }),
    );

    await waitFor(() => boundary("completed"));

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toBe(
      "https://api.nano-gpt.com/api/v1/chat/completions",
    );
    expect(fetchCalls[0].body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: TOOL_DEFINITION.inputSchema,
        },
      },
    ]);
    expect(fetchCalls[0].body.messages).toMatchObject([
      { role: "system", content: expect.stringContaining(CWD) },
      { role: "user", content: "read it" },
    ]);
    const secondRoundMessages = fetchCalls[1].body.messages as {
      role: string;
      tool_call_id?: string;
      content?: string;
    }[];
    expect(secondRoundMessages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file contents",
    });

    const deltas = deltaNotifications() as BoundaryDelta[];
    expect(
      deltas.find((delta) => delta.kind === "input.accepted"),
    ).toEqual({
      kind: "input.accepted",
      clientRequestId: "creq_abcdefgh23",
    });
    expect(deltas[1]).toEqual({
      kind: "input.accepted",
      clientRequestId: "creq_abcdefgh23",
    });
    expect(deltas.some((delta) => delta.kind === "turn.open")).toBe(true);
    expect(deltas.some((delta) => delta.kind === "usage")).toBe(true);
    expect(deltas.at(-1)).toEqual({
      kind: "turn.boundary",
      status: "completed",
    });

    const collector = createBridgeDeltaEventCollector(NANO_GPT_PROVIDER_ID);
    const events = harness.messages.flatMap((message) =>
      collector.assembleMessage(message),
    );
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("turn/started");
    expect(types).toContain("turn/input/accepted");
    expect(types.at(-1)).toBe("turn/completed");
    const completedItems = events
      .filter(
        (event): event is Extract<ThreadEvent, { type: "item/completed" }> =>
          event.type === "item/completed" &&
          (event.item.type === "toolCall" || event.item.type === "agentMessage"),
      )
      .map((event) => event.item);
    expect(completedItems.map((item) => item.type)).toEqual([
      "toolCall",
      "agentMessage",
    ]);
    expect(completedItems[1]).toMatchObject({ text: "All done." });
  });

  it("fails the turn when the API rejects the request", async () => {
    await initialize();
    responses.push(
      new Response(JSON.stringify({ error: { message: "No balance" } }), {
        status: 402,
      }),
    );
    const providerThreadId = await startThread();
    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "hi", mentions: [] }],
      clientRequestId: "creq_abcdefgh34",
      options: FULL_OPTIONS,
    });

    await waitFor(() => boundary("failed"));
    const error = (deltaNotifications() as BoundaryDelta[]).find(
      (delta) => delta.kind === "provider.error",
    );
    expect(error?.message).toContain("No balance");
  });

  it("lists no models without an API key", async () => {
    const response = await request("model/list", {});
    expect(response.result).toEqual({ models: [], selectedOnlyModels: [] });
    expect(fetchCalls).toHaveLength(0);
  });

  it("lists the live catalog when bb passes a key", async () => {
    responses.push(
      new Response(
        JSON.stringify({
          data: [{ id: "z-ai/glm-5.3" }, { id: "openai/gpt-6.1-sol" }],
        }),
        { status: 200 },
      ),
    );
    const response = await request("model/list", {
      envVars: { [NANO_GPT_API_KEY_ENV]: "sk-nano-bridge-test" },
    });
    const result = response.result as { models: { id: string }[] };
    expect(result.models.map((model) => model.id)).toEqual([
      "openai/gpt-6.1-sol",
      "z-ai/glm-5.3",
    ]);
  });

  it("fails a turn that carries no API key", async () => {
    await initialize();
    const providerThreadId = await startThread();
    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "hi", mentions: [] }],
      clientRequestId: "creq_abcdefgh56",
      options: { ...FULL_OPTIONS, envVars: {} },
    });
    await waitFor(() => boundary("failed"));
    expect(fetchCalls).toHaveLength(0);
  });

  it("reports unauthenticated health without an API key", async () => {
    delete process.env[NANO_GPT_API_KEY_ENV];
    const response = await request("provider/health", {
      providerId: NANO_GPT_PROVIDER_ID,
    });
    expect(response.result).toMatchObject({
      supported: true,
      health: { status: "unauthenticated" },
    });
  });

  it("does not claim session restore on start or resume", async () => {
    await initialize();
    const started = await request("thread/start", {
      threadId: THREAD_ID,
      cwd: CWD,
      instructionMode: "append",
      dynamicTools: [],
      options: FULL_OPTIONS,
    });
    expect(started.result).toMatchObject({ sessionRestorable: false });
    const resumed = await request("thread/resume", {
      threadId: THREAD_ID,
      providerThreadId: "nano_gpt_old_1",
      cwd: CWD,
      instructionMode: "append",
      dynamicTools: [],
      options: FULL_OPTIONS,
    });
    expect(resumed.result).toMatchObject({ sessionRestorable: false });
  });

  it("sums token usage over every model round of a turn", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_0", '{"path":"a"}', { prompt: 100, completion: 1 }),
      toolRoundResponse("call_0", '{"path":"b"}', { prompt: 200, completion: 1 }),
      sseResponse([
        chunk({ choices: [{ delta: { content: "ok" } }] }),
        chunk({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 300, completion_tokens: 2, total_tokens: 302 },
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh73", providerThreadId);
    for (let round = 0; round < 2; round += 1) {
      await waitFor(() => toolCallRequests().length > round);
      answerToolCall(round);
    }
    await waitFor(() => boundary("completed"));
    const usage = (
      deltaNotifications() as unknown as {
        kind: string;
        last: { inputTokens: number; outputTokens: number };
      }[]
    ).find((delta) => delta.kind === "usage");
    expect(usage?.last.inputTokens).toBe(600);
    expect(usage?.last.outputTokens).toBe(4);
  });

  it("uses unique item ids when the same call id repeats across rounds", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_0", '{"path":"a"}'),
      toolRoundResponse("call_0", '{"path":"b"}'),
      answerResponse("done"),
    );
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh62", providerThreadId);
    for (let round = 0; round < 2; round += 1) {
      await waitFor(() => toolCallRequests().length > round);
      answerToolCall(round);
    }
    await waitFor(() => boundary("completed"));
    const opened = (
      deltaNotifications() as unknown as {
        kind: string;
        key?: { providerItemId: string };
      }[]
    )
      .filter((delta) => delta.kind === "item.open")
      .map((delta) => delta.key?.providerItemId);
    expect(opened.length).toBeGreaterThan(2);
    expect(new Set(opened).size).toBe(opened.length);
  });

  it("does not run a tool whose arguments are not valid JSON", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_bad", '{"path":'),
      answerResponse("retrying"),
    );
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh63", providerThreadId);
    await waitFor(() => boundary("completed"));
    expect(toolCallRequests()).toHaveLength(0);
    const secondRound = fetchCalls[1].body.messages as {
      role: string;
      content?: string;
    }[];
    expect(secondRound.at(-1)?.role).toBe("tool");
    expect(secondRound.at(-1)?.content).toContain("The tool was not run");
  });

  it("settles a turn that is stopped while a tool call is pending", async () => {
    await initialize();
    responses.push(toolRoundResponse("call_1", '{"path":"a"}'));
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh64", providerThreadId);
    await waitFor(() => toolCallRequests().length > 0);
    const stop = await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    expect(stop.error).toBeUndefined();
    await waitFor(() => boundary("interrupted"));
    // A late answer for the stopped call is ignored and must not throw.
    answerToolCall(0);
    expect(fetchCalls).toHaveLength(1);
  });

  it("queues a second turn/start instead of running two turns at once", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_1", '{"path":"a"}'),
      answerResponse("first"),
      answerResponse("second"),
    );
    const providerThreadId = await startThread();
    await startTurn("one", "creq_abcdefgh65", providerThreadId);
    await waitFor(() => toolCallRequests().length > 0);
    await startTurn("two", "creq_abcdefgh66", providerThreadId);
    // The first turn still waits for its tool, so no second request yet.
    expect(fetchCalls).toHaveLength(1);
    answerToolCall(0);
    await waitFor(() => fetchCalls.length === 3);
    const secondTurn = fetchCalls[2].body.messages as {
      role: string;
      content?: string;
    }[];
    expect(secondTurn.at(-1)).toEqual({ role: "user", content: "two" });
  });

  it("fails a turn whose stream is cut off before it finished", async () => {
    await initialize();
    responses.push(
      sseResponse([chunk({ choices: [{ delta: { content: "half an ans" } }] })]),
    );
    const providerThreadId = await startThread();
    await startTurn("hi", "creq_abcdefgh67", providerThreadId);
    await waitFor(() => boundary("failed"));
    expect(boundary("completed")).toBe(false);
  });

  it("acknowledges a steered input exactly once", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_1", '{"path":"a"}'),
      answerResponse("first"),
      answerResponse("steered"),
    );
    const providerThreadId = await startThread();
    await startTurn("one", "creq_abcdefgh78", providerThreadId);
    await waitFor(() => toolCallRequests().length > 0);
    const steer = await request("turn/steer", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "two", mentions: [] }],
      clientRequestId: "creq_abcdefgh72",
      expectedTurnId: "turn-1",
      options: FULL_OPTIONS,
    });
    expect(steer.error).toBeUndefined();
    answerToolCall(0);
    await waitFor(() => fetchCalls.length === 3);
    await waitFor(
      () =>
        deltaNotifications().filter(
          (delta) => (delta as BoundaryDelta).kind === "turn.boundary",
        ).length === 2,
    );
    const accepted = (deltaNotifications() as BoundaryDelta[]).filter(
      (delta) => delta.kind === "input.accepted",
    );
    expect(accepted.map((delta) => delta.clientRequestId)).toEqual([
      "creq_abcdefgh78",
      "creq_abcdefgh72",
    ]);
  });

  it("closes a pending tool item as interrupted when the turn is stopped", async () => {
    await initialize();
    responses.push(toolRoundResponse("call_1", '{"path":"a"}'));
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh74", providerThreadId);
    await waitFor(() => toolCallRequests().length > 0);
    await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await waitFor(() => boundary("interrupted"));
    type ItemDelta = { kind: string; status?: string };
    const deltas = deltaNotifications() as unknown as ItemDelta[];
    const opened = deltas.filter((delta) => delta.kind === "item.open");
    const closed = deltas.filter((delta) => delta.kind === "item.close");
    expect(opened).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0].status).toBe("interrupted");
    const boundaries = deltas.filter((delta) => delta.kind === "turn.boundary");
    expect(boundaries).toHaveLength(1);
  });

  it("still ends an interrupt with an interrupted boundary when the request hangs", async () => {
    await initialize();
    // A response whose body never produces data and ignores the abort signal.
    responses.push(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const providerThreadId = await startThread();
    await startTurn("hang", "creq_abcdefgh75", providerThreadId);
    await waitFor(() => fetchCalls.length === 1);
    const started = Date.now();
    const stop = await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurn: null,
      activeTurnId: null,
    });
    expect(stop.error).toBeUndefined();
    // The worker is released by the abort itself, not by the 2 s fallback.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(boundary("interrupted")).toBe(true);
    const boundaries = (deltaNotifications() as BoundaryDelta[]).filter(
      (delta) => delta.kind === "turn.boundary",
    );
    expect(boundaries).toHaveLength(1);
  }, 10_000);

  it("runs another thread normally after a hung request was stopped", async () => {
    await initialize();
    responses.push(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      answerResponse("fresh"),
    );
    const providerThreadId = await startThread();
    await startTurn("hang", "creq_abcdefgh79", providerThreadId);
    await waitFor(() => fetchCalls.length === 1);
    await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    // Count notifications, the same unit used for the check below.
    const countAtStop = deltaMessages().length;

    const otherThread = "thr_nano_gpt_other";
    const started = await request("thread/start", {
      threadId: otherThread,
      cwd: CWD,
      instructionMode: "append",
      dynamicTools: [],
      options: FULL_OPTIONS,
    });
    const otherProviderId = (started.result as { providerThreadId: string })
      .providerThreadId;
    await request("turn/start", {
      threadId: otherThread,
      providerThreadId: otherProviderId,
      input: [{ type: "text", text: "hi", mentions: [] }],
      clientRequestId: "creq_abcdefgh7a",
      options: FULL_OPTIONS,
    });
    await waitFor(() => boundary("completed"));
    const afterStop = deltaMessages().slice(countAtStop);
    // A non-empty sample, so an empty list cannot pass vacuously.
    expect(afterStop.length).toBeGreaterThan(0);
    expect(onlyThread(afterStop, otherThread)).toBe(true);
  }, 10_000);

  it("the isolation check fails when a stale notification leaks in", () => {
    const own = { params: { threadId: "thr_b" } };
    const stale = { params: { threadId: "thr_a" } };
    expect(onlyThread([own, own], "thr_b")).toBe(true);
    expect(onlyThread([own, stale], "thr_b")).toBe(false);
    expect(onlyThread([], "thr_b")).toBe(false);
  });

  it("ends an interrupt with one boundary when fetch never returns", async () => {
    await initialize();
    // fetch ignores the signal and never settles: no response, no reader.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: unknown) => {
        fetchCalls.push({
          url: String(url),
          body: JSON.parse(String((init as RequestInit).body ?? "{}")),
        });
        return new Promise<Response>(() => undefined);
      }),
    );
    const providerThreadId = await startThread();
    await startTurn("hang", "creq_abcdefgh7b", providerThreadId);
    await waitFor(() => fetchCalls.length === 1);
    const stop = await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    expect(stop.error).toBeUndefined();
    expect(boundary("interrupted")).toBe(true);
    const boundaries = (deltaNotifications() as BoundaryDelta[]).filter(
      (delta) => delta.kind === "turn.boundary",
    );
    expect(boundaries).toHaveLength(1);
  }, 10_000);

  it("discards a queued follow-up when the turn is stopped", async () => {
    await initialize();
    responses.push(
      toolRoundResponse("call_1", '{"path":"a"}'),
      answerResponse("must never be requested"),
    );
    const providerThreadId = await startThread();
    await startTurn("one", "creq_abcdefgh7d", providerThreadId);
    await waitFor(() => toolCallRequests().length > 0);
    const steer = await request("turn/steer", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "two", mentions: [] }],
      clientRequestId: "creq_abcdefgh7e",
      expectedTurnId: "turn-1",
      options: FULL_OPTIONS,
    });
    expect(steer.error).toBeUndefined();
    await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    answerToolCall(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The queued input is dropped: no second model request, one boundary.
    expect(fetchCalls).toHaveLength(1);
    const boundaries = (deltaNotifications() as BoundaryDelta[]).filter(
      (delta) => delta.kind === "turn.boundary",
    );
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].status).toBe("interrupted");
  });

  it("drops a response that arrives after the turn was stopped", async () => {
    await initialize();
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: unknown) => {
        fetchCalls.push({
          url: String(url),
          body: JSON.parse(String((init as RequestInit).body ?? "{}")),
        });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }),
    );
    const providerThreadId = await startThread();
    await startTurn("late", "creq_abcdefgh7c", providerThreadId);
    await waitFor(() => fetchCalls.length === 1);
    await request("thread/stop", {
      threadId: THREAD_ID,
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    const countAtStop = deltaMessages().length;
    release(answerResponse("too late"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing from the late response may reach the timeline.
    expect(deltaMessages().length).toBe(countAtStop);
    expect(toolCallRequests()).toHaveLength(0);
  }, 10_000);

  it("fails the turn instead of finishing it when the model hits its length limit", async () => {
    await initialize();
    responses.push(
      sseResponse([
        chunk({ choices: [{ delta: { content: "a long answ" } }] }),
        chunk({ choices: [{ delta: {}, finish_reason: "length" }] }),
        "data: [DONE]\n\n",
      ]),
    );
    const providerThreadId = await startThread();
    await startTurn("write a lot", "creq_abcdefgh76", providerThreadId);
    await waitFor(() => boundary("failed"));
    expect(boundary("completed")).toBe(false);
    const error = (deltaNotifications() as BoundaryDelta[]).find(
      (delta) => delta.kind === "provider.error",
    );
    expect(error?.message).toContain("output length limit");
    expect(toolCallRequests()).toHaveLength(0);
  });

  it("does not run a tool call that was cut off by the length limit", async () => {
    await initialize();
    responses.push(
      sseResponse([
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_cut",
                    function: { name: "read_file", arguments: '{"path":"a' },
                  },
                ],
              },
              finish_reason: "length",
            },
          ],
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const providerThreadId = await startThread();
    await startTurn("go", "creq_abcdefgh77", providerThreadId);
    await waitFor(() => boundary("failed"));
    expect(toolCallRequests()).toHaveLength(0);
  });

  it("rejects steering when no turn is active", async () => {
    await initialize();
    const providerThreadId = await startThread();
    const response = await request("turn/steer", {
      threadId: THREAD_ID,
      providerThreadId,
      input: [{ type: "text", text: "more", mentions: [] }],
      clientRequestId: "creq_abcdefgh45",
      expectedTurnId: "turn-1",
      options: FULL_OPTIONS,
    });
    expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN);
  });
});

