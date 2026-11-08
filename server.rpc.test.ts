import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import nanoGptPlugin from "./server.js";
import { NANO_GPT_API_KEY_ENV, NANO_GPT_PROVIDER_ID } from "./src/vocabulary.js";

const ENV_CONTEXT = { threadId: null, projectId: null, hostId: "host-1" };

/** Answers NanoGPT's check-balance with `status`, and records every call. */
function stubNanoGpt(status: number): { urls: string[]; keys: string[] } {
  const seen = { urls: [] as string[], keys: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: unknown) => {
      seen.urls.push(String(url));
      const headers = new Headers((init as RequestInit).headers);
      seen.keys.push(headers.get("x-api-key") ?? "");
      return new Response(JSON.stringify({ usd_balance: "1.00" }), { status });
    }),
  );
  return seen;
}

function loadPlugin() {
  const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
  nanoGptPlugin(host.bb);
  return host;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the NanoGPT settings RPC", () => {
  it("reports no key before one is saved", async () => {
    const host = loadPlugin();
    await expect(host.harness.behavior.callRpc("getStatus", null)).resolves.toEqual({
      state: "none",
      baseUrl: "",
    });
  });

  it("does not save a key NanoGPT rejects", async () => {
    stubNanoGpt(401);
    const host = loadPlugin();
    const result = await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-bad",
      baseUrl: "",
    });
    expect(result).toMatchObject({ saved: false, state: "invalid" });
    await expect(host.harness.behavior.callRpc("getStatus", null)).resolves.toEqual({
      state: "none",
      baseUrl: "",
    });
    await expect(
      host.harness.behavior.resolveProviderEnv(NANO_GPT_PROVIDER_ID, ENV_CONTEXT),
    ).resolves.toEqual([]);
  });

  it("does not save a key it could not check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const host = loadPlugin();
    const result = await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-any",
      baseUrl: "",
    });
    expect(result).toMatchObject({ saved: false, state: "unknown" });
  });

  it("saves an accepted key, checks it with check-balance, and contributes it as env", async () => {
    const seen = stubNanoGpt(200);
    const host = loadPlugin();
    const result = await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-good",
      baseUrl: "",
    });
    expect(result).toMatchObject({ saved: true, state: "valid" });
    expect(seen.urls[0]).toBe("https://api.nano-gpt.com/api/check-balance");
    expect(seen.keys[0]).toBe("sk-good");

    await expect(host.harness.behavior.callRpc("getStatus", null)).resolves.toEqual({
      state: "valid",
      baseUrl: "",
    });
    const env = await host.harness.behavior.resolveProviderEnv(
      NANO_GPT_PROVIDER_ID,
      ENV_CONTEXT,
    );
    expect(env.map((entry) => entry.name)).toEqual([NANO_GPT_API_KEY_ENV]);
    expect(env[0]?.value).toBe("sk-good");
  });

  it("never returns the key through any RPC result", async () => {
    stubNanoGpt(200);
    const host = loadPlugin();
    const saved = await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-secret-value",
      baseUrl: "",
    });
    const status = await host.harness.behavior.callRpc("getStatus", null);
    expect(JSON.stringify([saved, status])).not.toContain("sk-secret-value");
  });

  it("announces a saved key over realtime", async () => {
    stubNanoGpt(200);
    const host = loadPlugin();
    await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-good",
      baseUrl: "",
    });
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "key-state",
      payload: { state: "valid", baseUrl: "" },
    });
  });

  it("removes the key and stops contributing env", async () => {
    stubNanoGpt(200);
    const host = loadPlugin();
    await host.harness.behavior.callRpc("saveKey", { apiKey: "sk-good", baseUrl: "" });
    await expect(host.harness.behavior.callRpc("clearKey", null)).resolves.toEqual({
      state: "none",
      baseUrl: "",
    });
    await expect(
      host.harness.behavior.resolveProviderEnv(NANO_GPT_PROVIDER_ID, ENV_CONTEXT),
    ).resolves.toEqual([]);
  });

  it("rejects a malformed base URL at the RPC boundary", async () => {
    const host = loadPlugin();
    await expect(
      host.harness.behavior.callRpc("saveKey", {
        apiKey: "sk-good",
        baseUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow();
  });
});
