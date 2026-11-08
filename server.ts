import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createApiKeyGate } from "./src/api-key-gate.js";
import {
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_PROVIDER_ID,
  type NanoGptProviderOptions,
} from "./src/vocabulary.js";

const SETUP_HINT =
  "Open the NanoGPT provider plugin settings and paste an API key from https://nano-gpt.com/api.";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "NanoGPT API key",
      description:
        "Create a key at https://nano-gpt.com/api. NanoGPT models appear only after the key is accepted.",
      secret: true,
    },
    baseUrl: {
      type: "string",
      label: "Base URL",
      description:
        "NanoGPT API base URL. Leave empty for https://api.nano-gpt.com/api/v1.",
      default: "",
    },
  });

  const gate = createApiKeyGate();
  settings.onChange(() => {
    gate.clear();
  });

  async function usableCredentials(): Promise<{
    apiKey: string;
    baseUrl: string | null;
  } | null> {
    const values = await settings.get();
    const apiKey = (values.apiKey ?? "").trim();
    if (apiKey === "") {
      return null;
    }
    const baseUrl = values.baseUrl.trim() === "" ? null : values.baseUrl.trim();
    return (await gate.isUsable(apiKey, baseUrl)) ? { apiKey, baseUrl } : null;
  }

  bb.providers.register({
    id: NANO_GPT_PROVIDER_ID,
    displayName: "NanoGPT",
    icon: "Zap",
    strings: {
      signInHint: SETUP_HINT,
      expiredHint: `NanoGPT rejected the API key. Update it in the NanoGPT provider plugin settings.`,
      installUrl: "https://nano-gpt.com/api",
      planModeCopy:
        "NanoGPT will outline a plan without executing tools when possible.",
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    composerActions: [],
    models: { fallback: [], scope: "host" },
    env: { passthrough: [NANO_GPT_API_KEY_ENV, NANO_GPT_BASE_URL_ENV] },
    deriveProviderOptions(context): NanoGptProviderOptions {
      const baseUrl =
        typeof context.settings.baseUrl === "string" &&
        context.settings.baseUrl.trim() !== ""
          ? context.settings.baseUrl.trim()
          : null;
      return {
        model: context.model,
        baseUrl,
        promptMode: context.promptMode ?? null,
      };
    },
  });

  bb.providers.experimental_contributeEnv(NANO_GPT_PROVIDER_ID, async () => {
    const credentials = await usableCredentials();
    if (credentials === null) {
      return [];
    }
    return [
      {
        name: NANO_GPT_API_KEY_ENV,
        value: credentials.apiKey,
        reason: "API key saved in the NanoGPT plugin settings",
      },
      ...(credentials.baseUrl === null
        ? []
        : [
            {
              name: NANO_GPT_BASE_URL_ENV,
              value: credentials.baseUrl,
              reason: "Base URL saved in the NanoGPT plugin settings",
            },
          ]),
    ];
  });

  bb.providers.experimental_contributeEnvHealth(
    NANO_GPT_PROVIDER_ID,
    async () => {
      const credentials = await usableCredentials();
      return credentials === null
        ? null
        : {
            label: "NanoGPT API key",
            statusMessage:
              "Using the API key saved in the NanoGPT plugin settings.",
          };
    },
  );

  void settings.get().then((values) => {
    if ((values.apiKey ?? "").trim() === "") {
      bb.status.needsConfiguration(SETUP_HINT);
    }
  });
}
