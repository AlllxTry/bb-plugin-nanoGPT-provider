import { z } from "zod";
import { normalizeBaseUrl } from "./base-url.js";
import { nanoGptModelIdSchema, normalizeModelId, RETRY_CONFIG } from "./vocabulary.js";
import type { NanoGptReasoningEffort } from "./reasoning.js";

const debug = process.env.NANOGPT_DEBUG === "1" ? console.error : () => undefined;

export const MODEL_LIST_TIMEOUT_MS = 10_000;
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

export class NanoGptApiError extends Error {
  readonly status: number;

  constructor(args: { status: number; message: string }) {
    super(args.message);
    this.name = "NanoGptApiError";
    this.status = args.status;
  }
}

export class NanoGptTimeoutError extends NanoGptApiError {
  constructor(message: string) {
    super({ status: 0, message });
    this.name = "NanoGptTimeoutError";
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
      /** The model's last `finish_reason` ("stop", "tool_calls", "length"...). */
      finishReason: string | null;
    };

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Waits for `promise`, but gives up with an AbortError as soon as the signal
 * aborts. A standards-compliant `fetch` already rejects on abort; this keeps a
 * turn from hanging when a transport ignores the signal, whether it stalls
 * before the response headers or after them. It only releases the caller: it
 * cannot free resources a broken transport holds. A value that arrives after
 * the abort is handed to `onLateValue` so it can be discarded cleanly.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    promise.then(onLateValue, () => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        reject(abortError());
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

function discardLateResponse(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** Check if an HTTP status code is retryable (transient error). */
function isRetryableStatus(status: number): boolean {
  return RETRY_CONFIG.retryableStatusCodes.includes(status as typeof RETRY_CONFIG.retryableStatusCodes[number]);
}

/** Calculate delay for next retry with exponential backoff and jitter. */
function calculateRetryDelay(attempt: number, response: Response | null): number {
  // Retry-After overrides local backoff for any retryable HTTP response.
  if (response !== null && isRetryableStatus(response.status)) {
    const retryAfter = response.headers.get("Retry-After")?.trim();
    if (retryAfter !== undefined) {
      if (/^\d+$/u.test(retryAfter)) {
        const delay = Number(retryAfter) * 1000;
        if (Number.isSafeInteger(delay)) return delay;
      } else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/u.test(retryAfter)) {
        // Require a weekday prefix so Date.parse cannot interpret malformed
        // delay-seconds such as "-1" or "1.5" as calendar dates.
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) return Math.max(0, date - Date.now());
      }
    }
  }
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  // Add jitter
  const jitter = Math.floor(Math.random() * (RETRY_CONFIG.jitterMs * 2)) - RETRY_CONFIG.jitterMs;
  // Cap at maxDelayMs, ensure minimum 100ms
  return Math.max(Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelayMs), 100);
}

/** Sleep for specified ms, respecting abort signal. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  // Larger Node.js timer delays overflow to 1ms. Split long server-directed
  // waits into supported chunks while keeping each chunk cancellable.
  while (ms > 0) {
    if (signal?.aborted) throw abortError();
    const delay = Math.min(ms, 2_147_483_647);
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    ms -= delay;
  }
}

async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  ms: number,
  message: string,
): Promise<T> {
  if (parent?.aborted) throw abortError();
  const deadline = new AbortController();
  const signal = parent === undefined ? deadline.signal : AbortSignal.any([parent, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), ms);
  timer.unref?.();
  try {
    return await work(signal);
  } catch (error) {
    if (parent?.aborted) throw abortError();
    if (deadline.signal.aborted) throw new NanoGptTimeoutError(message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
    data: z.array(z.object({
      id: nanoGptModelIdSchema,
      reasoning_efforts: z.unknown().optional(),
    }).passthrough()).min(1),
  })
  .passthrough();

export interface NanoGptModelCatalogEntry {
  id: string;
  reasoningEfforts: unknown;
}

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
  index: number | undefined;
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
  listModelCatalog(signal?: AbortSignal): Promise<NanoGptModelCatalogEntry[]>;
  streamChatCompletion(args: {
    model: string;
    messages: readonly NanoGptMessage[];
    tools?: readonly NanoGptToolDefinition[];
    reasoningEffort?: NanoGptReasoningEffort;
    signal?: AbortSignal;
  }): AsyncGenerator<NanoGptStreamEvent>;
}

export function createNanoGptClient(args: {
  baseUrl?: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): NanoGptClient {
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const apiKey = args.apiKey;

  function fetchImpl(input: string, init: RequestInit): Promise<Response> {
    const fetch = args.fetch ?? globalThis.fetch;
    return fetch(input, { ...init, redirect: "error" });
  }

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
  }

  async function fail(
    response: Response,
    signal?: AbortSignal,
  ): Promise<never> {
    const detail = await raceAbort(readErrorBody(response), signal);
    throw new NanoGptApiError({
      status: response.status,
      message: `NanoGPT API error ${response.status}: ${detail}`,
    });
  }

  async function fetchModels(url: string, signal?: AbortSignal): Promise<NanoGptModelCatalogEntry[]> {
    return withDeadline(async (requestSignal) => {
      const response = await raceAbort(
        fetchImpl(url, { method: "GET", headers: authHeaders(), signal: requestSignal }),
        requestSignal,
        discardLateResponse,
      );
      if (!response.ok) await fail(response, requestSignal);
      const parsed = modelListSchema.safeParse(await raceAbort(response.json(), requestSignal));
      if (!parsed.success) {
        throw new NanoGptApiError({
          status: response.status,
          message: "NanoGPT model list response had an unexpected shape",
        });
      }
      return parsed.data.data.map((model) => ({
        id: model.id,
        reasoningEfforts: model.reasoning_efforts,
      }));
    }, signal, MODEL_LIST_TIMEOUT_MS, "The NanoGPT model list timed out. Please try again.");
  }

  /** Fetches models without adding an internal deadline; relies on caller's deadline. */
  async function fetchModelsNoDeadline(url: string, signal?: AbortSignal): Promise<NanoGptModelCatalogEntry[]> {
    const response = await raceAbort(
      fetchImpl(url, { method: "GET", headers: authHeaders(), signal }),
      signal,
      discardLateResponse,
    );
    if (!response.ok) await fail(response, signal);
    const parsed = modelListSchema.safeParse(await raceAbort(response.json(), signal));
    if (!parsed.success) {
      throw new NanoGptApiError({
        status: response.status,
        message: "NanoGPT model list response had an unexpected shape",
      });
    }
    return parsed.data.data.map((model) => ({
      id: model.id,
      reasoningEfforts: model.reasoning_efforts,
    }));
  }

  return {
    async listModels(signal) {
      return (await fetchModels(`${baseUrl}/models`, signal)).map((model) => model.id);
    },

    async listModelCatalog(signal) {
      return withDeadline(async (deadlineSignal) => {
        try {
          return await fetchModelsNoDeadline(`${baseUrl}/models?detailed=true`, deadlineSignal);
        } catch (error) {
          if (!(error instanceof NanoGptApiError) || ![400, 404, 405, 422].includes(error.status)) {
            throw error;
          }
          const basic = await fetchModelsNoDeadline(`${baseUrl}/models`, deadlineSignal);
          return basic.map((model) => ({
            id: model.id,
            reasoningEfforts: undefined,
          }));
        }
      }, signal, MODEL_LIST_TIMEOUT_MS, "The NanoGPT model list timed out. Please try again.");
    },

    async *streamChatCompletion(streamArgs) {
      const body: Record<string, unknown> = {
        model: normalizeModelId(streamArgs.model),
        messages: streamArgs.messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (streamArgs.tools !== undefined && streamArgs.tools.length > 0) {
        body.tools = streamArgs.tools;
      }
      if (streamArgs.reasoningEffort !== undefined) {
        body.reasoning_effort = streamArgs.reasoningEffort;
      }
      if (streamArgs.signal?.aborted === true) {
        throw abortError();
      }
      // Retry loop for transient errors
      let lastResponse: Response | null = null;
      for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = calculateRetryDelay(attempt, lastResponse);
          debug?.(`NanoGPT retry: attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}, waiting ${delay}ms`);
          await sleep(delay, streamArgs.signal);
        }

        let response: Response;
        try {
          response = await withDeadline((signal) => raceAbort(
            fetchImpl(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: authHeaders(),
              body: JSON.stringify(body),
              signal,
            }),
            signal,
            discardLateResponse,
          ), streamArgs.signal, STREAM_IDLE_TIMEOUT_MS, "NanoGPT did not return response headers in time. Please try again.");
        } catch (err) {
          // Timeout or abort - fail immediately, don't retry
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          if (err instanceof NanoGptTimeoutError) throw err;
          if (attempt >= RETRY_CONFIG.maxRetries) throw err;
          lastResponse = null;
          debug?.(`NanoGPT request failed: ${err instanceof Error ? err.message : err}, retrying...`);
          continue;
        }

        lastResponse = response;

        if (response.ok) {
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
      const toolCalls: ToolCallAccumulator[] = [];
      const callsByIndex = new Map<number, ToolCallAccumulator>();
      const callsById = new Map<string, ToolCallAccumulator>();
      let doneStreaming = false;
      let sawFinishReason = false;
      let finishReason: string | null = null;

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
        const error = errorBodySchema.safeParse(payload);
        if (error.success && error.data.error !== undefined) {
          throw new NanoGptApiError({
            status: 0,
            message: `NanoGPT API error: ${error.data.error.message || "The upstream stream failed."}`,
          });
        }
        const parsed = streamChunkSchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        for (const choice of parsed.data.choices ?? []) {
          if (
            typeof choice.finish_reason === "string" &&
            choice.finish_reason !== ""
          ) {
            sawFinishReason = true;
            finishReason = choice.finish_reason;
          }
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
            const index = fragment.index;
            const id = fragment.id || undefined;
            const byIndex =
              index === undefined ? undefined : callsByIndex.get(index);
            const byId = id === undefined ? undefined : callsById.get(id);
            if (byIndex !== undefined && byId !== undefined && byIndex !== byId) {
              throw new NanoGptApiError({
                status: 0,
                message: "Conflicting tool-call identifiers in the NanoGPT stream.",
              });
            }
            let existing = byIndex ?? byId;
            if (index === undefined && id === undefined) {
              if (toolCalls.length > 1) {
                throw new NanoGptApiError({
                  status: 0,
                  message: "Ambiguous tool-call fragment in the NanoGPT stream: missing index and id.",
                });
              }
              existing = toolCalls[0];
            }
            if (existing === undefined) {
              existing = {
                index,
                id: id ?? "",
                name: fragment.function?.name ?? "",
                arguments: fragment.function?.arguments ?? "",
              };
              toolCalls.push(existing);
              if (index !== undefined) callsByIndex.set(index, existing);
              if (id !== undefined) callsById.set(id, existing);
              continue;
            }
            if (
              (id !== undefined && existing.id !== "" && existing.id !== id) ||
              (index !== undefined && existing.index !== undefined && existing.index !== index)
            ) {
              throw new NanoGptApiError({
                status: 0,
                message: "Conflicting tool-call identifiers in the NanoGPT stream.",
              });
            }
            if (index !== undefined) {
              existing.index = index;
              callsByIndex.set(index, existing);
            }
            if (id !== undefined) {
              existing.id = id;
              callsById.set(id, existing);
            }
            if (
              fragment.function?.name !== undefined &&
              fragment.function.name !== null &&
              fragment.function.name !== "" &&
              existing.name === ""
            ) {
              existing.name = fragment.function.name;
            }
            if (typeof fragment.function?.arguments === "string") {
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

      try {
        while (!doneStreaming) {
          const { done, value } = await withDeadline(
            (signal) => raceAbort(reader.read(), signal),
            streamArgs.signal, STREAM_IDLE_TIMEOUT_MS,
            "The NanoGPT stream timed out while waiting for data. Please try again.",
          );
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
          yield* drainCollected();
          if (done) {
            break;
          }
        }
        if (!doneStreaming && buffer.startsWith("data:")) {
          handleData(buffer.replace(/\r$/u, "").slice("data:".length).trim());
        }
        yield* drainCollected();
      } finally {
        // Always ask the transport to drop the connection, on success, error
        // and abort. The cancel is requested but not awaited, so a
        // misbehaving transport that never settles it cannot keep this
        // generator (or the turn) alive. This is best-effort cleanup; it
        // cannot force a broken transport to release its resources.
        reader.cancel().catch(() => undefined);
      }

      // A stream that stops without [DONE] and without a finish_reason was cut
      // off: the text or the tool-call arguments may be incomplete, so fail
      // instead of presenting it as a finished answer.
      if (!doneStreaming && !sawFinishReason) {
        throw new NanoGptApiError({
          status: 0,
          message:
            "The NanoGPT stream ended before the answer was complete. Please try again.",
        });
      }

      const orderedCalls = [...toolCalls]
        .sort((left, right) => (left.index ?? Infinity) - (right.index ?? Infinity))
        .map((call, position) => {
          let id = call.id;
          if (id === "") {
            id = `call_${call.index ?? position}`;
            while (callsById.has(id)) id += "_";
            callsById.set(id, call);
          }
          return {
            id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          };
        });

      yield {
        type: "message",
        content: messageContent,
        toolCalls: orderedCalls,
        usage,
        finishReason,
      };

      // Success - exit retry loop
      return;
    }

    // Non-OK response - read error body first for a good message
    if (!response.ok) {
      try {
        await withDeadline((signal) => fail(response, signal), streamArgs.signal, STREAM_IDLE_TIMEOUT_MS, "NanoGPT timed out while returning an error response.");
      } catch (err) {
        // Timeout reading error body - propagate immediately
        if (err instanceof NanoGptTimeoutError || (err instanceof DOMException && err.name === "AbortError")) throw err;
        // Other errors from fail() are NanoGptApiError with status - retry if retryable
        if (!isRetryableStatus(response.status)) throw err;
        if (attempt >= RETRY_CONFIG.maxRetries) {
          throw new NanoGptApiError({
            status: response.status,
            message: `${err instanceof Error ? err.message : String(err)} (after ${attempt + 1} attempts)`,
          });
        }
        debug?.(`NanoGPT request failed with ${response.status}, will retry...`);
        continue;
      }
    }

    // Retryable status - continue to next attempt
    debug?.(`NanoGPT request failed with ${response.status}, will retry...`);
  }

  // Exhausted all retries
  throw new NanoGptApiError({
    status: lastResponse?.status ?? 0,
    message: `NanoGPT request failed after ${RETRY_CONFIG.maxRetries + 1} attempts. Please try again later.`,
  });
    },
  };
}
