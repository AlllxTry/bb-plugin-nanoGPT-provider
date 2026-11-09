import { describe, expect, it } from "vitest";
import {
  PROVIDER_DEFAULT_REASONING_LEVEL,
  normalizeReasoningEfforts,
  reasoningOptions,
  resolveReasoningSelection,
  validateReasoningSelection,
} from "./reasoning.js";

describe("NanoGPT reasoning effort policy", () => {
  it("keeps Provider default available when metadata is absent or malformed", () => {
    for (const metadata of [undefined, null, {}, "high", ["high", 4]]) {
      const efforts = normalizeReasoningEfforts(metadata);
      expect(efforts).toEqual([]);
      expect(reasoningOptions(efforts)).toEqual([
        expect.objectContaining({
          reasoningEffort: PROVIDER_DEFAULT_REASONING_LEVEL,
          label: "Provider default",
        }),
      ]);
      expect(validateReasoningSelection({ kind: "provider-default" }, efforts))
        .toEqual({ kind: "provider-default" });
    }
  });

  it("intersects catalog metadata with supported levels and orders it consistently", () => {
    expect(normalizeReasoningEfforts(["high", "xhigh", "medium", "low", "high"]))
      .toEqual(["low", "medium", "high"]);
    expect(normalizeReasoningEfforts(["high", "xhigh"]))
      .toEqual(["high"]);
  });

  it("creates namespaced picker IDs and keeps the provider default separate from Medium", () => {
    expect(reasoningOptions(["high", "medium"])).toEqual([
      expect.objectContaining({ reasoningEffort: PROVIDER_DEFAULT_REASONING_LEVEL }),
      expect.objectContaining({ reasoningEffort: "nanogpt:effort:medium", label: "Medium" }),
      expect.objectContaining({ reasoningEffort: "nanogpt:effort:high", label: "High" }),
    ]);
  });

  it("preserves the prior bare medium value as Provider default", () => {
    expect(resolveReasoningSelection("medium")).toEqual({ kind: "provider-default" });
    expect(resolveReasoningSelection(PROVIDER_DEFAULT_REASONING_LEVEL))
      .toEqual({ kind: "provider-default" });
    expect(resolveReasoningSelection(undefined)).toEqual({ kind: "provider-default" });
    expect(resolveReasoningSelection(null)).toEqual({ kind: "provider-default" });
  });

  it.each(["low", "medium", "high"] as const)("resolves explicit %s", (effort) => {
    const selection = resolveReasoningSelection(`nanogpt:effort:${effort}`);
    expect(selection).toEqual({ kind: "explicit", effort });
    expect(validateReasoningSelection(selection, [effort])).toEqual(selection);
  });

  it("rejects an explicit choice absent from the model's declared capabilities", () => {
    const selection = resolveReasoningSelection("nanogpt:effort:high");
    expect(() => validateReasoningSelection(selection, ["low", "medium"]))
      .toThrow(/does not declare high/);
  });

  it.each(["low", "xhigh", "unknown", 4])("rejects unrecognized picker values: %s", (value) => {
    expect(() => resolveReasoningSelection(value)).toThrow(/Unsupported NanoGPT reasoning selection/);
  });
});
