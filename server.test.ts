import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import nanoGptPlugin from "./server.js";
import {
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_PROVIDER_ID,
} from "./src/vocabulary.js";

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
