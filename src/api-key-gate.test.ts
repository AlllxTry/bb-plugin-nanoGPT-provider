import { describe, expect, it } from "vitest";
import {
  buildCheckRequest,
  checkApiKey,
  createApiKeyGate,
  type ApiKeyState,
} from "./api-key-gate.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("buildCheckRequest", () => {
  it("uses the authenticated check-balance endpoint for the default base URL", () => {
    const request = buildCheckRequest("sk-1", null);
    expect(request.url).toBe("https://api.nano-gpt.com/api/check-balance");
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toEqual({ "x-api-key": "sk-1" });
  });

  it("uses check-balance on any nano-gpt.com base URL, including v1legacy", () => {
    expect(
      buildCheckRequest("k", "https://nano-gpt.com/api/v1legacy/").url,
    ).toBe("https://nano-gpt.com/api/check-balance");
  });

  it("does not treat a look-alike host as NanoGPT", () => {
    const request = buildCheckRequest("k", "https://evil-nano-gpt.com/v1");
    expect(request.url).toBe("https://evil-nano-gpt.com/v1/models");
    expect(request.init.method).toBe("GET");
    expect(request.init.headers).toEqual({ authorization: "Bearer k" });
  });

  it("falls back to an authenticated models call for another host", () => {
    expect(buildCheckRequest("k", "http://localhost:8080/v1").url).toBe(
      "http://localhost:8080/v1/models",
    );
  });
});

describe("checkApiKey", () => {
  it("never validates a key through the unauthenticated models endpoint", async () => {
    const urls: string[] = [];
    await checkApiKey({
      apiKey: "good",
      baseUrl: null,
      fetch: async (input) => {
        urls.push(String(input));
        return jsonResponse({ balance: 1 });
      },
    });
    expect(urls).toEqual(["https://api.nano-gpt.com/api/check-balance"]);
  });

  it("accepts a key NanoGPT authenticates", async () => {
    await expect(
      checkApiKey({
        apiKey: "good",
        baseUrl: null,
        fetch: async () => jsonResponse({ usd_balance: "1.00" }),
      }),
    ).resolves.toBe("valid");
  });

  it("rejects a key NanoGPT answers with 401", async () => {
    await expect(
      checkApiKey({
        apiKey: "bad",
        baseUrl: null,
        fetch: async () => jsonResponse({ error: { message: "no" } }, 401),
      }),
    ).resolves.toBe("invalid");
  });

  it("reports unknown when NanoGPT is unreachable", async () => {
    await expect(
      checkApiKey({
        apiKey: "k",
        baseUrl: null,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toBe("unknown");
  });
});

describe("createApiKeyGate", () => {
  it("only lets an accepted key through and caches the verdict", async () => {
    let calls = 0;
    const gate = createApiKeyGate(async ({ apiKey }) => {
      calls += 1;
      return apiKey === "good" ? "valid" : "invalid";
    });
    await expect(gate.isUsable("good", null)).resolves.toBe(true);
    await expect(gate.isUsable("good", null)).resolves.toBe(true);
    await expect(gate.isUsable("bad", null)).resolves.toBe(false);
    expect(calls).toBe(2);
  });

  it("keeps a previously accepted key usable while offline, but never an unchecked one", async () => {
    let state: ApiKeyState = "valid";
    let clock = 0;
    const gate = createApiKeyGate(
      async () => state,
      () => clock,
    );
    await expect(gate.isUsable("good", null)).resolves.toBe(true);
    state = "unknown";
    clock = 10 * 60_000;
    await expect(gate.isUsable("good", null)).resolves.toBe(true);
    await expect(gate.isUsable("other", null)).resolves.toBe(false);
  });

  it("re-checks after clear", async () => {
    let state: ApiKeyState = "invalid";
    const gate = createApiKeyGate(async () => state);
    await expect(gate.isUsable("k", null)).resolves.toBe(false);
    state = "valid";
    gate.clear();
    await expect(gate.isUsable("k", null)).resolves.toBe(true);
  });
});
