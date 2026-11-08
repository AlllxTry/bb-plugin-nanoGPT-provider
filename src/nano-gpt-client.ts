import { z } from "zod";
import { NANO_GPT_DEFAULT_BASE_URL } from "./vocabulary.js";

export class NanoGptApiError extends Error {
  readonly status: number;

  constructor(args: { status: number; message: string }) {
    super(args.message);
    this.name = "NanoGptApiError";
    this.status = args.status;
  }
}

export interface NanoGptToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type NanoGptContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type NanoGptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | NanoGptContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: NanoGptToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface NanoGptToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface NanoGptTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type NanoGptStreamEvent =
  | { type: "textDelta"; text: string }
  | { type: "reasoningDelta"; text: string }
  | {
      type: "message";
      content: string;
      toolCalls: NanoGptToolCall[];
      usage: NanoGptTokenUsage | null;
    };

const toolCallFragmentSchema = z
  .object({
    index: z.number().int().nonnegative().optional(),
    id: z.string().nullable().optional(),
    function: z
      .object({
        name: z.string().nullable().optional(),
        arguments: z.string().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
                reasoning: z.string().nullable().optional(),
                reasoning_content: z.string().nullable().optional(),
                tool_calls: z.array(toolCallFragmentSchema).optional(),
              })
              .passthrough()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().nonnegative().nullable().optional(),
        completion_tokens: z.number().nonnegative().nullable().optional(),
        total_tokens: z.number().nonnegative().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const modelListSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1),
  })
  .passthrough();

const errorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
    message: z.string().optional(),
  })
  .passthrough();

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

async function readErrorBody(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
  if (text === "") {
    return response.statusText || `HTTP ${response.status}`;
  }
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const message =
        parsed.data.error?.message ?? parsed.data.message ?? null;
      if (message !== null && message !== "") {
        return message;
      }
    }
  } catch {
    return text.slice(0, 500);
  }
  return text.slice(0, 500);
}

export interface NanoGptClient {
  listModels(signal?: AbortSignal): Promise<string[]>;
  streamChatCompletion(args: {
    model: string;
    messages: readonly NanoGptMessage[];
    tools?: readonly NanoGptToolDefinition[];
    signal?: AbortSignal;
  }): AsyncGenerator<NanoGptStreamEvent>;
}

export function createNanoGptClient(args: {
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): NanoGptClient {
  const baseUrl = (args.baseUrl ?? NANO_GPT_DEFAULT_BASE_URL).replace(
    /\/+$/u,
    "",
  );
  const apiKey = args.apiKey;

  function fetchImpl(input: string, init: RequestInit): Promise<Response> {
    const fetch = args.fetch ?? globalThis.fetch;
    return fetch(input, init);
  }

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
  }

  async function fail(response: Response): Promise<never> {
    const detail = await readErrorBody(response);
    throw new NanoGptApiError({
      status: response.status,
      message: `NanoGPT API error ${response.status}: ${detail}`,
    });
  }

  return {
    async listModels(signal) {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: "GET",
        headers: authHeaders(),
        signal,
      });
      if (!response.ok) {
        await fail(response);
      }
      const parsed = modelListSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new NanoGptApiError({
          status: response.status,
          message: "NanoGPT model list response had an unexpected shape",
        });
      }
      return parsed.data.data.map((model) => model.id);
    },

    async *streamChatCompletion(streamArgs) {
      const body: Record<string, unknown> = {
        model: streamArgs.model,
        messages: streamArgs.messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (streamArgs.tools !== undefined && streamArgs.tools.length > 0) {
        body.tools = streamArgs.tools;
      }
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: streamArgs.signal,
      });
      if (!response.ok) {
        await fail(response);
      }
      if (response.body === null) {
        throw new NanoGptApiError({
          status: response.status,
          message: "NanoGPT stream returned no response body",
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let messageContent = "";
      let usage: NanoGptTokenUsage | null = null;
      const toolCalls = new Map<number, ToolCallAccumulator>();
      let doneStreaming = false;

      const handleData = (data: string): void => {
        if (data === "[DONE]") {
          doneStreaming = true;
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        const parsed = streamChunkSchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        for (const choice of parsed.data.choices ?? []) {
          const delta = choice.delta;
          if (delta === undefined) {
            continue;
          }
          if (typeof delta.content === "string" && delta.content !== "") {
            content += delta.content;
            messageContent += delta.content;
          }
          const reasoningFragment =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string"
                ? delta.reasoning
                : "";
          if (reasoningFragment !== "") {
            reasoning += reasoningFragment;
          }
          for (const fragment of delta.tool_calls ?? []) {
            const index = fragment.index ?? 0;
            const existing = toolCalls.get(index);
            if (existing === undefined) {
              toolCalls.set(index, {
                id: fragment.id ?? `call_${index}`,
                name: fragment.function?.name ?? "",
                arguments: fragment.function?.arguments ?? "",
              });
              continue;
            }
            if (fragment.id !== undefined && fragment.id !== null) {
              existing.id = fragment.id;
            }
            if (
              fragment.function?.name !== undefined &&
              fragment.function.name !== null &&
              fragment.function.name !== "" &&
              existing.name === ""
            ) {
              existing.name = fragment.function.name;
            }
            if (fragment.function?.arguments !== undefined) {
              existing.arguments += fragment.function.arguments;
            }
          }
        }
        const chunkUsage = parsed.data.usage;
        if (chunkUsage !== null && chunkUsage !== undefined) {
          const inputTokens = chunkUsage.prompt_tokens ?? 0;
          const outputTokens = chunkUsage.completion_tokens ?? 0;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens:
              chunkUsage.total_tokens ?? inputTokens + outputTokens,
          };
        }
      };

      function* drainCollected(): Generator<NanoGptStreamEvent> {
        if (content !== "") {
          yield { type: "textDelta", text: content };
          content = "";
        }
        if (reasoning !== "") {
          yield { type: "reasoningDelta", text: reasoning };
          reasoning = "";
        }
      }

      while (!doneStreaming) {
        const { done, value } = await reader.read();
        if (value !== undefined) {
          buffer += decoder.decode(value, { stream: true });
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/u, "");
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice("data:".length).trim();
          if (data === "") {
            continue;
          }
          yield* drainCollected();
          handleData(data);
        }
        if (done) {
          break;
        }
      }
      if (!doneStreaming && buffer.startsWith("data:")) {
        handleData(buffer.slice("data:".length).trim());
      }
      yield* drainCollected();
      try {
        await reader.cancel();
      } catch {
      }

      const orderedCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id === "" ? `call_${index}` : call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));

      const finalUsage = usage;
      yield {
        type: "message",
        content: messageContent,
        toolCalls: orderedCalls,
        usage: finalUsage,
      };

    },

  };
}


