import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { checkApiKey, createApiKeyGate } from "./src/api-key-gate.js";
import { normalizeBaseUrl } from "./src/base-url.js";
import {
  nanoGptSettingsContract,
  REALTIME_KEY_STATE_CHANNEL,
  type NanoGptStatus,
} from "./src/settings-contract.js";
import {
  NANO_GPT_API_KEY_ENV,
  NANO_GPT_BASE_URL_ENV,
  NANO_GPT_PROVIDER_ID,
  type NanoGptProviderOptions,
} from "./src/vocabulary.js";
import {
  NANO_GPT_REASONING_EFFORTS,
  PROVIDER_DEFAULT_REASONING_LEVEL,
} from "./src/reasoning.js";
import {
  HISTORY_PAGE_SIZE,
  HISTORY_TOOL_NAME,
  historyPageRequestSchema,
} from "./src/history-protocol.js";

export { nanoGptSettingsContract };

const SETUP_HINT =
  "Click the gear in the composer, or open the NanoGPT provider plugin settings, and paste an API key from https://nano-gpt.com/api.";

export default function plugin(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: HISTORY_TOOL_NAME,
    description: "Read a page of this thread's saved conversation events for provider context restoration.",
    parameters: historyPageRequestSchema,
    presentation: {
      label: { pending: "Restoring conversation context", completed: "Conversation context restored" },
      icon: { glyph: "History" },
      suppress: true,
    },
    async execute(args, context) {
      context.signal.throwIfAborted();
      let throughSeq = args.throughSeq;
      if (throughSeq === null) {
        const latest = await bb.sdk.threads.events.list({
          threadId: context.threadId,
          order: "desc",
          limit: "1",
          signal: context.signal,
        });
        throughSeq = latest[0]?.seq ?? 0;
      }
      const rows = await bb.sdk.threads.events.list({
        threadId: context.threadId,
        ...(args.afterSeq === null ? {} : { afterSeq: String(args.afterSeq) }),
        beforeSeq: String(throughSeq + 1),
        limit: String(HISTORY_PAGE_SIZE),
        order: "asc",
        types: [
          "client/turn/requested",
          "turn/input/accepted",
          "turn/started",
          "turn/completed",
          "item/completed",
          "system/operation",
          "thread/context/cleared",
        ],
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      const nextAfterSeq = rows.length === HISTORY_PAGE_SIZE
        ? rows.at(-1)?.seq ?? null
        : null;
      return JSON.stringify({
        version: 1,
        threadId: context.threadId,
        throughSeq,
        nextAfterSeq,
        events: rows,
      });
    },
  });

  bb.agents.configure((context) => ({
    tools: context.provider.id === NANO_GPT_PROVIDER_ID ? [HISTORY_TOOL_NAME] : [],
    skills: [],
  }));

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

  const gate = createApiKeyGate((args) =>
    checkApiKey({
      ...args,
      log: (detail) => bb.log.info(`key check: ${detail}`),
    }),
  );
  settings.onChange(() => {
    gate.clear();
  });

  async function readSaved(): Promise<{
    apiKey: string;
    baseUrl: string | null;
  }> {
    const values = await settings.get();
    const baseUrl = (values.baseUrl ?? "").trim();
    return {
      apiKey: (values.apiKey ?? "").trim(),
      baseUrl: baseUrl === "" ? null : normalizeBaseUrl(baseUrl),
    };
  }

  async function usableCredentials(): Promise<{
    apiKey: string;
    baseUrl: string | null;
  } | null> {
    const saved = await readSaved();
    if (saved.apiKey === "") {
      return null;
    }
    return (await gate.isUsable(saved.apiKey, saved.baseUrl)) ? saved : null;
  }

  async function status(): Promise<NanoGptStatus> {
    const saved = await readSaved();
    if (saved.apiKey === "") {
      return { state: "none", baseUrl: saved.baseUrl ?? "" };
    }
    return {
      state: await gate.verdict(saved.apiKey, saved.baseUrl),
      baseUrl: saved.baseUrl ?? "",
    };
  }

  function announce(next: NanoGptStatus): void {
    bb.realtime.publish(REALTIME_KEY_STATE_CHANNEL, next);
  }

  bb.rpc.register(nanoGptSettingsContract, {
    getStatus: () => status(),

    async saveKey({ apiKey, baseUrl }) {
      const proposedBaseUrl = baseUrl === "" ? null : baseUrl;
      const state = await gate.verdict(apiKey, proposedBaseUrl);
      bb.log.info(`saveKey: verdict ${state}`);
      if (state === "invalid") {
        return {
          saved: false,
          state,
          message: "NanoGPT rejected this API key. Check it and try again.",
        };
      }
      if (state === "unknown") {
        return {
          saved: false,
          state,
          message:
            "Could not reach NanoGPT to check the key, so it was not saved. Check your connection and try again.",
        };
      }
      await settings.experimental_set({ apiKey, baseUrl: proposedBaseUrl ?? "" });
      gate.rememberAccepted(apiKey, proposedBaseUrl);
      announce({ state: "valid", baseUrl: proposedBaseUrl ?? "" });
      return {
        saved: true,
        state,
        message: "Key accepted. NanoGPT models are loading.",
      };
    },

    async clearKey() {
      await settings.experimental_set({ apiKey: null });
      const next = await status();
      announce(next);
      return next;
    },
  });

  bb.providers.register({
    id: NANO_GPT_PROVIDER_ID,
    displayName: "NanoGPT",
    icon: "./assets/icon.svg",
    strings: {
      signInHint: SETUP_HINT,
      expiredHint: `NanoGPT rejected the API key. Click the gear in the composer to update it.`,
      installUrl: "https://nano-gpt.com/api",
      planModeCopy:
        "NanoGPT will outline a plan without executing tools.",
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
      reasoningLevels: ["medium"],
    },
    reasoningLevels: [
      { id: PROVIDER_DEFAULT_REASONING_LEVEL, label: "Provider default", description: "Let the selected NanoGPT model use its default reasoning behavior." },
      ...NANO_GPT_REASONING_EFFORTS.map((effort) => ({
        id: `nanogpt:effort:${effort}`,
        label: effort[0]!.toUpperCase() + effort.slice(1),
        description: `Request ${effort} reasoning effort when supported by the selected NanoGPT model.`,
      })),
    ],
    composerActions: ["plan"],
    models: { fallback: [], scope: "host" },
    env: { passthrough: [NANO_GPT_API_KEY_ENV, NANO_GPT_BASE_URL_ENV] },
    deriveProviderOptions(context): NanoGptProviderOptions {
      const baseUrl =
        typeof context.settings.baseUrl === "string" &&
        context.settings.baseUrl.trim() !== ""
          ? normalizeBaseUrl(context.settings.baseUrl)
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
}
