import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NanoGptApiError,
  MODEL_LIST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  createNanoGptClient,
  type NanoGptStreamEvent,
} from "./nano-gpt-client.js";
import { NANO_GPT_DEFAULT_BASE_URL } from "./vocabulary.js";

afterEach(() => vi.useRealTimers());

function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(
  events: AsyncGenerator<NanoGptStreamEvent>,
): Promise<NanoGptStreamEvent[]> {
  const collected: NanoGptStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("streamChatCompletion", () => {
  it.each([" ", "a\nb", "a".repeat(513)])("rejects invalid model IDs before fetch", async (model) => {
    const fetch = vi.fn();
    const client = createNanoGptClient({ apiKey: "test", fetch });
    await expect(collect(client.streamChatCompletion({ model, messages: [] }))).rejects.toThrow(/Model ID must/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["headers", "body", "error body"])("times out stalled completion %s", async (stage) => {
    vi.useFakeTimers();
    const client = createNanoGptClient({ apiKey: "test", fetch: async () => {
      if (stage === "headers") return new Promise<Response>(() => undefined);
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: stage === "error body" ? 503 : 200 });
    } });
    const promise = collect(client.streamChatCompletion({ model: "test", messages: [] }));
    const assertion = expect(promise).rejects.toMatchObject({ name: "NanoGptTimeoutError" });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets idle deadlines per read and does not time out while the consumer is paused", async () => {
    vi.useFakeTimers();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const client = createNanoGptClient({ apiKey: "test", fetch: async () => new Response(stream) });
    const iterator = client.streamChatCompletion({ model: "test", messages: [] });
    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    writer.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: "first" } }] })));
    await expect(first).resolves.toMatchObject({ value: { type: "textDelta", text: "first" } });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2);
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    writer.enqueue(new TextEncoder().encode(chunk({ choices: [{ delta: { content: "second" }, finish_reason: "stop" }] })));
    await expect(second).resolves.toMatchObject({ value: { type: "textDelta", text: "second" } });
    writer.close();
    await iterator.next();
    await iterator.return(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      name: "parallel calls identified only by id",
      fragments: [
        { id: "a", function: { name: "first", arguments: '{"a":' } },
        { id: "b", function: { name: "second", arguments: '{"b":2}' } },
        { id: "a", function: { arguments: "1}" } },
      ],
      expected: [
        { id: "a", function: { name: "first", arguments: '{"a":1}' } },
        { id: "b", function: { name: "second", arguments: '{"b":2}' } },
      ],
    },
    {
      name: "mixed indexed and id-only calls without index collisions",
      fragments: [
        { id: "a", function: { name: "first", arguments: '{"a":' } },
        { index: 0, id: "b", function: { name: "second", arguments: '{"b":' } },
        { id: "a", function: { arguments: "1}" } },
        { index: 0, function: { arguments: "2}" } },
      ],
      expected: [
        { id: "b", function: { name: "second", arguments: '{"b":2}' } },
        { id: "a", function: { name: "first", arguments: '{"a":1}' } },
      ],
    },
    {
      name: "an indexed call continued by id",
      fragments: [
        { index: 2, id: "a", function: { name: "first", arguments: '{"a":' } },
        { id: "a", function: { arguments: "1}" } },
      ],
      expected: [{ id: "a", function: { name: "first", arguments: '{"a":1}' } }],
    },
  ])("keeps $name separate", async ({ fragments, expected }) => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () => sseResponse([
        ...fragments.map((fragment) => chunk({ choices: [{ delta: { tool_calls: [fragment] } }] })),
        chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ].join("")),
    });
    const events = await collect(client.streamChatCompletion({ model: "test", messages: [] }));
    expect(events.at(-1)).toMatchObject({ type: "message", toolCalls: expected });
  });

  it.each([
    { name: "ambiguous", fragments: [
      { id: "a", function: { name: "first", arguments: "{" } },
      { id: "b", function: { name: "second", arguments: "{" } },
      { function: { arguments: "}" } },
    ], error: /Ambiguous tool-call/ },
    { name: "conflicting", fragments: [
      { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
      { index: 1, id: "b", function: { name: "second", arguments: "{}" } },
      { index: 0, id: "b", function: { arguments: "{}" } },
    ], error: /Conflicting tool-call/ },
  ])("rejects $name tool-call identities", async ({ fragments, error }) => {
    const client = createNanoGptClient({ apiKey: "sk-nano-test", fetch: async () => sseResponse([
      ...fragments.map((fragment) => chunk({ choices: [{ delta: { tool_calls: [fragment] } }] })),
      "data: [DONE]\n\n",
    ].join("")) });
    await expect(collect(client.streamChatCompletion({ model: "test", messages: [] }))).rejects.toThrow(error);
  });

  it.each([false, true])("surfaces an SSE error with partial text: %s", async (partial) => {
    const client = createNanoGptClient({ apiKey: "sk-nano-test", fetch: async () => sseResponse([
      ...(partial ? [chunk({ choices: [{ delta: { content: "partial" } }] })] : []),
      chunk({ error: { message: "insufficient balance", code: "no_balance" } }),
      "data: [DONE]\n\n",
    ].join("")) });
    const events: NanoGptStreamEvent[] = [];
    await expect((async () => {
      for await (const event of client.streamChatCompletion({ model: "test", messages: [] })) events.push(event);
    })()).rejects.toThrow("insufficient balance");
    expect(events).toEqual(partial ? [{ type: "textDelta", text: "partial" }] : []);
  });

  it("ignores null argument fragments between tool-call chunks", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () => sseResponse([
        chunk({ choices: [{ delta: { tool_calls: [{
          index: 0, id: "call_1",
          function: { name: "read_file", arguments: '{"pa' },
        }] } }] }),
        chunk({ choices: [{ delta: { tool_calls: [{
          index: 0, function: { arguments: null },
        }] } }] }),
        chunk({ choices: [{ delta: { tool_calls: [{
          index: 0, function: { arguments: 'th":"a"}' },
        }] }, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ].join("")),
    });
    const events = await collect(client.streamChatCompletion({
      model: "test", messages: [{ role: "user", content: "read a" }],
    }));
    expect(events.at(-1)).toMatchObject({
      type: "message",
      toolCalls: [{ id: "call_1", function: {
        name: "read_file", arguments: '{"path":"a"}',
      } }],
    });
  });

  it("streams text, reasoning, tool calls, and usage", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          init: init as RequestInit,
        });
        return sseResponse(
          [
            chunk({
              choices: [
                { delta: { reasoning_content: "thinking about it" } },
              ],
            }),
            chunk({
              choices: [{ delta: { content: "Hello" } }],
            }),
            chunk({
              choices: [{ delta: { content: " world" } }],
            }),
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "read_file", arguments: '{"pa' },
                      },
                    ],
                  },
                },
              ],
            }),
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: "ignored", arguments: 'th":"x"}' },
                      },
                    ],
                  },
                },
              ],
            }),
            chunk({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }),
            "data: [DONE]\n\n",
          ].join(""),
        );
      },
    });

    const events = await collect(
      client.streamChatCompletion({
        model: "openai/gpt-6.1-sol",
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${NANO_GPT_DEFAULT_BASE_URL}/chat/completions`);
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-nano-test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      model: "openai/gpt-6.1-sol",
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(events.filter((event) => event.type === "textDelta")).toEqual([
      { type: "textDelta", text: "Hello" },
      { type: "textDelta", text: " world" },
    ]);
    expect(events.filter((event) => event.type === "reasoningDelta")).toEqual([
      { type: "reasoningDelta", text: "thinking about it" },
    ]);
    const final = events.at(-1);
    expect(final).toEqual({
      type: "message",
      content: "Hello world",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"x"}' },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "tool_calls",
    });
  });

  it("ends a read that never produces data when the signal aborts", async () => {
    // The injected fetch ignores the signal and the body never yields a chunk,
    // like a non-cooperative transport.
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const controller = new AbortController();
    const pending = collect(
      client.streamChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    // No wall-clock bound needed: if the read were not released, this would
    // never settle and the test would fail on the runner's own timeout.
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ends a request whose fetch never returns when the signal aborts", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: () => new Promise<Response>(() => undefined),
    });
    const controller = new AbortController();
    const pending = collect(
      client.streamChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the body of a response that arrives after the abort", async () => {
    let cancelled = false;
    let deliver: (response: Response) => void = () => undefined;
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = collect(
      client.streamChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    deliver(
      new Response(
        new ReadableStream<Uint8Array>({
          start() {},
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
        }),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        client.streamChatCompletion({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails a stream that ends with no [DONE] and no finish reason", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () =>
        sseResponse(chunk({ choices: [{ delta: { content: "cut o" } }] })),
    });
    await expect(
      collect(
        client.streamChatCompletion({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).rejects.toBeInstanceOf(NanoGptApiError);
  });

  it("accepts a stream that ends with a finish reason but no [DONE]", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () =>
        sseResponse(
          chunk({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          }),
        ),
    });
    const events = await collect(
      client.streamChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "message", content: "ok" });
  });

  it("maps HTTP errors to NanoGptApiError with the API message", async () => {
    const client = createNanoGptClient({
      apiKey: "bad",
      fetch: async () =>
        jsonResponse(
          { error: { message: "Invalid API key" } },
          401,
        ),
    });
    await expect(
      collect(
        client.streamChatCompletion({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).rejects.toBeInstanceOf(NanoGptApiError);
    try {
      await collect(
        client.streamChatCompletion({
          model: "x",
          messages: [{ role: "user", content: "hi" }],
        }),
      );
    } catch (error) {
      expect((error as NanoGptApiError).status).toBe(401);
      expect((error as NanoGptApiError).message).toContain(
        "Invalid API key",
      );
    }
  });
});

describe("listModels", () => {
  it.each(["headers", "JSON body", "error body"])("bounds stalled model-list %s", async (stage) => {
    vi.useFakeTimers();
    const client = createNanoGptClient({ apiKey: "test", fetch: async () => {
      if (stage === "headers") return new Promise<Response>(() => undefined);
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: stage === "error body" ? 503 : 200 });
    } });
    const assertion = expect(client.listModels()).rejects.toMatchObject({ name: "NanoGptTimeoutError" });
    await vi.advanceTimersByTimeAsync(MODEL_LIST_TIMEOUT_MS);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns model ids from the OpenAI-style list", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () =>
        jsonResponse({
          object: "list",
          data: [
            { id: "openai/gpt-6.1-sol", object: "model" },
            { id: "z-ai/glm-5.3", object: "model" },
          ],
        }),
    });
    await expect(client.listModels()).resolves.toEqual([
      "openai/gpt-6.1-sol",
      "z-ai/glm-5.3",
    ]);
  });

  it("rejects on a malformed list", async () => {
    const client = createNanoGptClient({
      apiKey: "sk-nano-test",
      fetch: async () => jsonResponse({ unexpected: true }),
    });
    await expect(client.listModels()).rejects.toBeInstanceOf(
      NanoGptApiError,
    );
  });
});
