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
  it("saves tool controls without a key or network request and normalizes exact names", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const host = loadPlugin();
    await expect(host.harness.behavior.callRpc("getToolSettings", null)).resolves.toEqual({ disallowedTools: "", confirmToolCalls: false });
    await expect(host.harness.behavior.callRpc("saveToolSettings", { disallowedTools: "read_file, write_file\nread_file", confirmToolCalls: true })).resolves.toEqual({ disallowedTools: "read_file\nwrite_file", confirmToolCalls: true });
    await expect(host.harness.behavior.callRpc("getToolSettings", null)).resolves.toEqual({ disallowedTools: "read_file\nwrite_file", confirmToolCalls: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid tool controls without replacing saved values", async () => {
    const host = loadPlugin();
    const saved = { disallowedTools: "read_file", confirmToolCalls: true };
    await host.harness.behavior.callRpc("saveToolSettings", saved);
    await expect(host.harness.behavior.callRpc("saveToolSettings", { disallowedTools: "read_*", confirmToolCalls: false })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("saveToolSettings", { disallowedTools: "", confirmToolCalls: "false" })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("getToolSettings", null)).resolves.toEqual(saved);
  });
  it("keeps tool controls when updating the key and excludes the key from tool settings", async () => {
    stubNanoGpt(200);
    const host = loadPlugin();
    const saved = { disallowedTools: "read_file", confirmToolCalls: true };
    await host.harness.behavior.callRpc("saveToolSettings", saved);
    await host.harness.behavior.callRpc("saveKey", { apiKey: "synthetic-secret", baseUrl: "" });
    const next = await host.harness.behavior.callRpc("getToolSettings", null);
    expect(next).toEqual(saved);
    expect(JSON.stringify(next)).not.toContain("synthetic-secret");
  });
  it("does not contribute an old key when its check finishes after removal", async () => {
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    const host = loadPlugin();
    await host.harness.behavior.setSettings({ apiKey: "old-key" });
    const pending = host.harness.behavior.resolveProviderEnv(NANO_GPT_PROVIDER_ID, ENV_CONTEXT);
    await vi.waitFor(() => expect(complete).toBeDefined());
    await host.harness.behavior.callRpc("clearKey", null);
    complete(new Response("{}", { status: 200 }));
    await expect(pending).resolves.toEqual([]);
  });

  it("ignores unsafe saved URLs instead of failing status, without checking a key", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const host = loadPlugin();
    await expect(host.harness.behavior.callRpc("saveKey", { apiKey: "test", baseUrl: "http://example.com/v1" })).rejects.toThrow();
    // A URL saved through a path this plugin does not validate must not break
    // status or env contribution: it is ignored in favor of the default.
    await host.harness.behavior.setSettings({ apiKey: "test", baseUrl: "http://example.com/v1" });
    // The invalid saved URL is ignored; status resolves instead of throwing.
    // It now reaches the default endpoint for the key verdict (the broken URL
    // no longer aborts the RPC), which is exactly the M4 fix.
    await expect(host.harness.behavior.callRpc("getStatus", null)).resolves.toMatchObject({ state: "unknown", baseUrl: "" });
    await expect(host.harness.behavior.resolveProviderEnv(NANO_GPT_PROVIDER_ID, ENV_CONTEXT)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toBe("https://api.nano-gpt.com/api/check-balance");
  });

  it("updates the server health contribution when the saved key is added and removed", async () => {
    stubNanoGpt(200);
    const host = loadPlugin();
    const health = () => host.harness.behavior.resolveProviderEnvHealth(NANO_GPT_PROVIDER_ID, { hostId: "host-1" });
    await expect(health()).resolves.toBeNull();
    await host.harness.behavior.callRpc("saveKey", { apiKey: "sk-good", baseUrl: "" });
    await expect(health()).resolves.toMatchObject({ label: "NanoGPT API key" });
    await host.harness.behavior.callRpc("clearKey", null);
    await expect(health()).resolves.toBeNull();
  });

  it("reads a legacy null base URL without breaking status or provider env", async () => {
    stubNanoGpt(200);
    const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
    const define = vi.spyOn(host.bb.settings, "define");
    nanoGptPlugin(host.bb);
    const settings = define.mock.results[0].value;
    // Simulate an older store returning null instead of the string default.
    vi.spyOn(settings, "get").mockResolvedValue({
      apiKey: "sk-good", baseUrl: null as unknown as string,
    });
    await expect(host.harness.behavior.callRpc("getStatus", null)).resolves.toEqual({
      state: "valid", baseUrl: "",
    });
    await expect(host.harness.behavior.resolveProviderEnv(
      NANO_GPT_PROVIDER_ID, ENV_CONTEXT,
    )).resolves.toEqual([expect.objectContaining({
      name: NANO_GPT_API_KEY_ENV, value: "sk-good",
    })]);
  });

  it("stores an empty base URL as a string", async () => {
    stubNanoGpt(200);
    const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
    const define = vi.spyOn(host.bb.settings, "define");
    nanoGptPlugin(host.bb);
    const settings = define.mock.results[0].value;
    const save = vi.spyOn(settings, "experimental_set");
    await host.harness.behavior.callRpc("saveKey", {
      apiKey: "sk-good", baseUrl: "",
    });
    expect(save).toHaveBeenCalledWith({ apiKey: "sk-good", baseUrl: "" });
  });

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
