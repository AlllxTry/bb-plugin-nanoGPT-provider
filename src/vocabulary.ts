import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const NANO_GPT_PLUGIN_ID = "nanogpt-provider";

export const NANO_GPT_PROVIDER_ID = "nano-gpt";

export const NANO_GPT_DEFAULT_BASE_URL = "https://api.nano-gpt.com/api/v1";

export const NANO_GPT_API_KEY_ENV = "NANOGPT_API_KEY";

export const NANO_GPT_BASE_URL_ENV = "NANOGPT_BASE_URL";

export const NANO_GPT_DEFAULT_MODEL_ID = "openai/gpt-6.1-sol";

function fallbackModel(
  id: string,
  displayName: string,
  description: string,
  isDefault: boolean,
): PluginProviderFallbackModel {
  return {
    id,
    displayName,
    description,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Default" },
    ],
    defaultReasoningEffort: "medium",
    isDefault,
  };
}

export const NANO_GPT_FALLBACK_MODELS: readonly PluginProviderFallbackModel[] = [
  fallbackModel(
    "openai/gpt-6.1-sol",
    "GPT-6.1 Sol",
    "OpenAI frontier chat model routed through NanoGPT.",
    true,
  ),
  fallbackModel(
    "z-ai/glm-5.3",
    "GLM 5.3",
    "Z.ai GLM 5.3 chat model routed through NanoGPT.",
    false,
  ),
  fallbackModel(
    "deepseek/deepseek-v4-flash-0731",
    "DeepSeek V4 Flash",
    "DeepSeek V4 Flash chat model routed through NanoGPT.",
    false,
  ),
];

export const nanoGptProviderOptionsSchema = z.object({
  model: z.string(),
  baseUrl: z.string().url().nullable(),
  promptMode: z.enum(["plan"]).nullable(),
});

export type NanoGptProviderOptions = z.infer<typeof nanoGptProviderOptionsSchema>;

export function modelDisplayName(modelId: string): string {
  const segment = modelId.split("/").pop() ?? modelId;
  return segment === "" ? modelId : segment;
}

export const MAX_TOOL_ROUNDS = 40;
