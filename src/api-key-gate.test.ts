import { describe, expect, it } from "vitest";
import {
  checkApiKey,
  createApiKeyGate,
  type ApiKeyState,
} from "./api-key-gate.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("checkApiKey", () => {
  it("accepts a key NanoGPT lists models for", async () => {
    await expect(
      checkApiKey({
        apiKey: "good",
        baseUrl: null,
        fetch: async () => jsonResponse({ data: [{ id: "a/b" }] }),
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
