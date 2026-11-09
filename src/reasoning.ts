/** NanoGPT effort levels this plugin knows how to send. */
export const NANO_GPT_REASONING_EFFORTS = ["low", "medium", "high"] as const;

export type NanoGptReasoningEffort = (typeof NANO_GPT_REASONING_EFFORTS)[number];

export const PROVIDER_DEFAULT_REASONING_LEVEL = "nanogpt:provider-default";

const EXPLICIT_LEVEL_PREFIX = "nanogpt:effort:";

const EFFORT_LABELS: Record<NanoGptReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const EFFORT_DESCRIPTIONS: Record<NanoGptReasoningEffort, string> = {
  low: "Use low reasoning effort when NanoGPT declares it for this model.",
  medium: "Use medium reasoning effort when NanoGPT declares it for this model.",
  high: "Use high reasoning effort when NanoGPT declares it for this model.",
};

export interface NanoGptReasoningOption {
  reasoningEffort: string;
  label: string;
  description: string;
}

export type NanoGptReasoningSelection =
  | { kind: "provider-default" }
  | { kind: "explicit"; effort: NanoGptReasoningEffort };

/**
 * Convert NanoGPT's documented `reasoning_efforts` catalog field to the
 * supported subset. A malformed or absent field means capabilities are
 * unknown; it must never disable the provider-default option.
 */
export function normalizeReasoningEfforts(value: unknown): NanoGptReasoningEffort[] {
  if (!Array.isArray(value) || !value.every((level) => typeof level === "string")) {
    return [];
  }

  const advertised = new Set(value);
  return NANO_GPT_REASONING_EFFORTS.filter((effort) => advertised.has(effort));
}

export function reasoningOptions(
  advertisedEfforts: readonly NanoGptReasoningEffort[],
): NanoGptReasoningOption[] {
  const seen = new Set<NanoGptReasoningEffort>();
  const options: NanoGptReasoningOption[] = [{
    reasoningEffort: PROVIDER_DEFAULT_REASONING_LEVEL,
    label: "Provider default",
    description: "Let the selected NanoGPT model use its default reasoning behavior.",
  }];

  for (const effort of NANO_GPT_REASONING_EFFORTS) {
    if (!advertisedEfforts.includes(effort) || seen.has(effort)) continue;
    seen.add(effort);
    options.push({
      reasoningEffort: `${EXPLICIT_LEVEL_PREFIX}${effort}`,
      label: EFFORT_LABELS[effort],
      description: EFFORT_DESCRIPTIONS[effort],
    });
  }

  return options;
}

/**
 * Resolve the host's picker ID to a request policy. The old bare `medium`
 * value represented Provider default in previous plugin versions and retains
 * that meaning when a saved thread or host sends it after an upgrade.
 */
export function resolveReasoningSelection(value: unknown): NanoGptReasoningSelection {
  if (value === undefined || value === null || value === "" ||
      value === PROVIDER_DEFAULT_REASONING_LEVEL || value === "medium") {
    return { kind: "provider-default" };
  }

  if (typeof value === "string" && value.startsWith(EXPLICIT_LEVEL_PREFIX)) {
    const effort = value.slice(EXPLICIT_LEVEL_PREFIX.length);
    if (NANO_GPT_REASONING_EFFORTS.includes(effort as NanoGptReasoningEffort)) {
      return { kind: "explicit", effort: effort as NanoGptReasoningEffort };
    }
  }

  throw new Error(`Unsupported NanoGPT reasoning selection: ${String(value)}`);
}

export function validateReasoningSelection(
  selection: NanoGptReasoningSelection,
  advertisedEfforts: readonly NanoGptReasoningEffort[],
): NanoGptReasoningSelection {
  if (selection.kind === "explicit" && !advertisedEfforts.includes(selection.effort)) {
    throw new Error(
      `NanoGPT model does not declare ${selection.effort} reasoning effort. Choose Provider default or a supported effort.`,
    );
  }
  return selection;
}
