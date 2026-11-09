import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { NANO_GPT_PROVIDER_ID } from "./provider-id.js";
import { PROVIDER_DEFAULT_REASONING_LEVEL } from "./reasoning.js";

export { NANO_GPT_PROVIDER_ID };

export { NANO_GPT_DEFAULT_BASE_URL } from "./base-url.js";

export const NANO_GPT_API_KEY_ENV = "NANOGPT_API_KEY";

export const NANO_GPT_BASE_URL_ENV = "NANOGPT_BASE_URL";

export const NANO_GPT_DEFAULT_MODEL_ID = "openai/gpt-6.1-sol";

export const nanoGptModelIdSchema = z.string().trim().min(1).max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export function normalizeModelId(value: unknown): string {
  const parsed = nanoGptModelIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("Model ID must be non-empty, at most 512 characters, and contain no control characters.");
  return parsed.data;
}

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
      { reasoningEffort: PROVIDER_DEFAULT_REASONING_LEVEL, label: "Provider default", description: "Use the upstream model's default reasoning." },
    ],
    defaultReasoningEffort: PROVIDER_DEFAULT_REASONING_LEVEL,
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
  model: nanoGptModelIdSchema,
  baseUrl: z.string().url().nullable(),
  promptMode: z.enum(["plan"]).nullable(),
});

export type NanoGptProviderOptions = z.infer<typeof nanoGptProviderOptionsSchema>;

export function modelDisplayName(modelId: string): string {
  const segment = modelId.split("/").pop() ?? modelId;
  return segment === "" ? modelId : segment;
}

export const MAX_TOOL_ROUNDS = 40;

// Retry configuration for transient HTTP errors
export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
  jitterMs: 500,
  retryableStatusCodes: [429, 502, 503, 504] as const,
};

export type RetryConfig = typeof RETRY_CONFIG;
