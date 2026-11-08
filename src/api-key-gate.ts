export type ApiKeyState = "valid" | "invalid" | "unknown";

const CHECK_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60_000;
const DEFAULT_BASE_URL = "https://api.nano-gpt.com/api/v1";

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
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
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
  const keyOf = (apiKey: string, baseUrl: string | null): string =>
    `${baseUrl ?? ""}\n${apiKey}`;

  async function verdict(
    apiKey: string,
    baseUrl: string | null,
  ): Promise<ApiKeyState> {
    const id = keyOf(apiKey, baseUrl);
    const cached = cache.get(id);
    if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) {
      return cached.state;
    }
    const state = await check({ apiKey, baseUrl });
    if (state === "unknown") {
      return state;
    }
    cache.set(id, { state, at: now() });
    if (state === "valid") {
      accepted.add(id);
    } else {
      accepted.delete(id);
    }
    return state;
  }

  return {
    verdict,
    async isUsable(apiKey, baseUrl) {
      const state = await verdict(apiKey, baseUrl);
      return (
        state === "valid" ||
        (state === "unknown" && accepted.has(keyOf(apiKey, baseUrl)))
      );
    },
    clear() {
      cache.clear();
    },
  };
}
