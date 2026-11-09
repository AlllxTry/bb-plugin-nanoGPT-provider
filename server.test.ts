import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import nanoGptPlugin from "./server.js";
import {
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_PROVIDER_ID,
} from "./src/vocabulary.js";
import { HISTORY_TOOL_NAME } from "./src/history-protocol.js";

function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
  nanoGptPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === NANO_GPT_PROVIDER_ID,
  );
  if (declaration === undefined) {
    throw new Error(`provider "${NANO_GPT_PROVIDER_ID}" was not registered`);
  }
  return { host, declaration };
}

const ENV_CONTEXT = { threadId: null, projectId: null, hostId: "host-1" };

describe("the NanoGPT provider registration", () => {
  it("registers a hidden, paginated history reader scoped to the active thread", async () => {
    const host = createFakePluginHost({ pluginId: "nanogpt-provider" });
    nanoGptPlugin(host.bb);
    const tool = host.harness.registrations.agentTools.find((entry) => entry.name === HISTORY_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.presentation?.suppress).toBe(true);
    expect(host.harness.registrations.agentConfigurationProvider?.({
      provider: { id: NANO_GPT_PROVIDER_ID } as never,
      thread: { id: "thread-1" }, project: { id: "project-1" },
    } as never)).toMatchObject({ tools: [HISTORY_TOOL_NAME] });
    expect(host.harness.registrations.agentConfigurationProvider?.({
      provider: { id: "other" } as never,
      thread: { id: "thread-1" }, project: { id: "project-1" },
    } as never)).toMatchObject({ tools: [] });

    const calls: Record<string, unknown>[] = [];
    host.harness.sdk.stub("threads.events.list", ((args: Record<string, unknown>) => {
      calls.push(args);
      if (args.order === "desc") return [{ seq: 31 }];
      if (args.afterSeq === undefined) return Array.from({ length: 25 }, (_, index) => ({ seq: index + 1 }));
      return [{ seq: 26 }, { seq: 31 }];
    }) as never);
    const context = { threadId: "thread-1", signal: new AbortController().signal };
    const first = JSON.parse(String(await tool!.execute({ afterSeq: null, throughSeq: null, currentRequestId: null }, context as never)));
    const second = JSON.parse(String(await tool!.execute({ afterSeq: first.nextAfterSeq, throughSeq: first.throughSeq, currentRequestId: null }, context as never)));

    expect(first).toMatchObject({ threadId: "thread-1", throughSeq: 31, nextAfterSeq: 25 });
    expect(first.events).toHaveLength(25);
    expect(second).toMatchObject({ threadId: "thread-1", throughSeq: 31, nextAfterSeq: null });
    expect(second.events.map((event: { seq: number }) => event.seq)).toEqual([26, 31]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toMatchObject({ threadId: "thread-1", beforeSeq: "32", order: "asc", limit: "25" });
    expect(calls[2]).toMatchObject({ threadId: "thread-1", afterSeq: "25", beforeSeq: "32", order: "asc" });
  });

  it("exposes plan mode and supported reasoning option descriptors", () => {
    const { declaration } = registeredDeclaration();
    expect(declaration.capabilities.permissionModes).toEqual(["full"]);
    expect(declaration.composerActions).toEqual(["plan"]);
    expect(declaration.capabilities.reasoningLevels).toEqual(["medium"]);
    expect(declaration.reasoningLevels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "nanogpt:provider-default", label: "Provider default" }),
      expect.objectContaining({ id: "nanogpt:effort:low", label: "Low" }),
      expect.objectContaining({ id: "nanogpt:effort:medium", label: "Medium" }),
      expect.objectContaining({ id: "nanogpt:effort:high", label: "High" }),
    ]));
    expect(declaration.deriveProviderOptions?.({
      threadId: "thread", projectId: "project", model: "test",
      permissionMode: "full", promptMode: "plan", settings: {},
    })).toMatchObject({ promptMode: "plan" });
    expect(() => declaration.deriveProviderOptions?.({
      threadId: "thread", projectId: "project", model: "test", permissionMode: "full",
      settings: { baseUrl: "http://example.com/v1" },
    })).toThrow(/Base URL/);
  });

  it("registers the provider with no models until a key is accepted", () => {
    const { declaration } = registeredDeclaration();
    expect(declaration.displayName).toBe("NanoGPT");
    expect(declaration.maintenance).toEqual({
      health: true,
      usage: false,
      installation: false,
    });
    expect(declaration.models?.fallback).toEqual([]);
  });

  it("uses the plugin's own SVG as the provider icon, and that file is a clean vector mark", () => {
    const { declaration } = registeredDeclaration();
    expect(declaration.icon).toBe("./assets/icon.svg");
    const manifest = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ) as { bb: { branding: { icon: string } } };
    expect(manifest.bb.branding.icon).toBe("./assets/icon.svg");
    const svg = readFileSync(
      new URL("./assets/icon.svg", import.meta.url),
      "utf8",
    );
    expect(svg).toMatch(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toMatch(
      /<(script|style|image|foreignObject|a)\b|<\?xml|<!DOCTYPE|\bon[a-z]+=|href=|url\(/i,
    );
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(32 * 1024);
  });

  it("passes the API key and base URL environment through to the bridge", () => {
    expect(registeredDeclaration().declaration.env?.passthrough).toEqual([
      NANO_GPT_API_KEY_ENV,
      NANO_GPT_BASE_URL_ENV,
    ]);
  });

  it("contributes no environment while no API key is saved", async () => {
    const { host } = registeredDeclaration();
    await expect(
      host.harness.behavior.resolveProviderEnv(
        NANO_GPT_PROVIDER_ID,
        ENV_CONTEXT,
      ),
    ).resolves.toEqual([]);
    await expect(
      host.harness.behavior.resolveProviderEnvHealth(NANO_GPT_PROVIDER_ID, {
        hostId: "host-1",
      }),
    ).resolves.toBeNull();
  });
});
