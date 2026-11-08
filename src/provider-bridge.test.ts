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
        sessionRestore: true,
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

