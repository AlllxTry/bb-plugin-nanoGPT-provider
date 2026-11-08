import { createHash } from "node:crypto";
import { normalizeBaseUrl } from "./base-url.js";

export type ApiKeyState = "valid" | "invalid" | "unknown";

const CHECK_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60_000;
const UNKNOWN_TTL_MS = 5_000;
const MAX_CACHE_ENTRIES = 64;

export interface ApiKeyCheckArgs {
  apiKey: string;
  baseUrl: string | null;
  fetch?: typeof globalThis.fetch;
  /** Told what NanoGPT answered. Never receives the key. */
  log?: (detail: string) => void;
}

interface CheckRequest {
  url: string;
  init: RequestInit;
}

/**
 * NanoGPT answers `GET /models` with 200 even for a missing or wrong key, so
 * that endpoint proves nothing. `POST /api/check-balance` is authenticated and
 * answers 401 for a bad key, so it is the real check. A custom base URL on
 * another host has no such endpoint; for it the best available check is an
 * authenticated `GET <base>/models`.
 */
export function buildCheckRequest(
  apiKey: string,
  baseUrl: string | null,
): CheckRequest {
  const base = normalizeBaseUrl(baseUrl);
  let host = "";
  let origin = "";
  try {
    const parsed = new URL(base);
    host = parsed.hostname.toLowerCase();
    origin = parsed.origin;
  } catch {
    host = "";
  }
  if (host === "nano-gpt.com" || host.endsWith(".nano-gpt.com")) {
    return {
      url: `${origin}/api/check-balance`,
      init: { method: "POST", headers: { "x-api-key": apiKey } },
    };
  }
  return {
    url: `${base}/models`,
    init: { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
  };
}

export async function checkApiKey(args: ApiKeyCheckArgs): Promise<ApiKeyState> {
  const request = buildCheckRequest(args.apiKey, args.baseUrl);
  const doFetch = args.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(request.url, {
      ...request.init,
      redirect: "error",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const target = new URL(request.url);
    args.log?.(`${request.init.method} ${target.host}${target.pathname} answered HTTP ${response.status}`);
    if (response.ok) {
      return "valid";
    }
    if (response.status === 401 || response.status === 403) {
      return "invalid";
    }
    return "unknown";
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `no answer within ${CHECK_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : "request failed";
    args.log?.(`could not reach NanoGPT: ${reason}`);
    return "unknown";
  }
}

export interface ApiKeyGate {
  /** NanoGPT's current answer for the key, cached for a minute. */
  verdict(apiKey: string, baseUrl: string | null): Promise<ApiKeyState>;
  isUsable(apiKey: string, baseUrl: string | null): Promise<boolean>;
  clear(): void;
  /** Preserve a just-verified saved key after settings change cleared the gate. */
  rememberAccepted(apiKey: string, baseUrl: string | null): void;
}

/**
 * Decides whether a saved API key may be handed to the provider. Only a key
 * NanoGPT accepts is usable; when NanoGPT cannot be reached the key stays
 * usable only if it was accepted before.
 */
export function createApiKeyGate(
  check: (args: ApiKeyCheckArgs) => Promise<ApiKeyState> = checkApiKey,
  now: () => number = Date.now,
): ApiKeyGate {
  const cache = new Map<string, { state: ApiKeyState; at: number }>();
  const accepted = new Set<string>();
  const inflight = new Map<string, Promise<ApiKeyState>>();
  let generation = 0;
  const keyOf = (apiKey: string, baseUrl: string | null): string =>
    createHash("sha256").update(`${normalizeBaseUrl(baseUrl)}\n${apiKey}`).digest("hex");

  function store(id: string, state: ApiKeyState): void {
    cache.delete(id);
    cache.set(id, { state, at: now() });
    if (state === "valid") accepted.add(id);
    if (state === "invalid") accepted.delete(id);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      accepted.delete(oldest);
    }
  }

  async function verdict(
    apiKey: string,
    baseUrl: string | null,
  ): Promise<ApiKeyState> {
    const id = keyOf(apiKey, baseUrl);
    const cached = cache.get(id);
    if (cached !== undefined && now() - cached.at < (cached.state === "unknown" ? UNKNOWN_TTL_MS : CACHE_TTL_MS)) {
      return cached.state;
    }
    const pending = inflight.get(id);
    if (pending !== undefined) return pending;
    if (inflight.size >= MAX_CACHE_ENTRIES) return "unknown";
    const requestGeneration = generation;
    const request = Promise.resolve().then(() => check({ apiKey, baseUrl }))
      .then((state) => {
        if (generation !== requestGeneration) return "unknown" as const;
        store(id, state);
        return state;
      })
      .finally(() => {
        if (inflight.get(id) === request) inflight.delete(id);
      });
    inflight.set(id, request);
    return request;
  }

  return {
    verdict,
    async isUsable(apiKey, baseUrl) {
      const requestGeneration = generation;
      const state = await verdict(apiKey, baseUrl);
      return (
        generation === requestGeneration &&
        (state === "valid" ||
          (state === "unknown" && accepted.has(keyOf(apiKey, baseUrl))))
      );
    },
    clear() {
      generation++;
      cache.clear();
      accepted.clear();
      inflight.clear();
    },
    rememberAccepted(apiKey, baseUrl) {
      store(keyOf(apiKey, baseUrl), "valid");
    },
  };
}
