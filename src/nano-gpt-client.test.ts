import { describe, expect, it } from "vitest";
import {
  NanoGptApiError,
  createNanoGptClient,
  type NanoGptStreamEvent,
} from "./nano-gpt-client.js";
import { NANO_GPT_DEFAULT_BASE_URL } from "./vocabulary.js";

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
    const started = Date.now();
    const pending = collect(
      client.streamChatCompletion({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(1000);
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
