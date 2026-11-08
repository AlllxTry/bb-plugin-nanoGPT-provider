import { NanoGptApiError, createNanoGptClient } from "./nano-gpt-client.js";

export type ApiKeyState = "valid" | "invalid" | "unknown";

const CHECK_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60_000;

export interface ApiKeyCheckArgs {
  apiKey: string;
  baseUrl: string | null;
  fetch?: typeof globalThis.fetch;
}

export async function checkApiKey(args: ApiKeyCheckArgs): Promise<ApiKeyState> {
  try {
    const client = createNanoGptClient({
      apiKey: args.apiKey,
      ...(args.baseUrl === null ? {} : { baseUrl: args.baseUrl }),
      ...(args.fetch === undefined ? {} : { fetch: args.fetch }),
    });
    await client.listModels(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    return "valid";
  } catch (error) {
    if (
      error instanceof NanoGptApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return "invalid";
    }
    return "unknown";
  }
}

export interface ApiKeyGate {
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
  return {
    async isUsable(apiKey, baseUrl) {
      const id = `${baseUrl ?? ""}\n${apiKey}`;
      const cached = cache.get(id);
      if (cached !== undefined && now() - cached.at < CACHE_TTL_MS) {
        return cached.state === "valid";
      }
      const state = await check({ apiKey, baseUrl });
      if (state === "unknown") {
        return accepted.has(id);
      }
      cache.set(id, { state, at: now() });
      if (state === "valid") {
        accepted.add(id);
      } else {
        accepted.delete(id);
      }
      return state === "valid";
    },
    clear() {
      cache.clear();
    },
  };
}
