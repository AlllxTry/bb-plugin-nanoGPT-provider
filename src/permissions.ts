import type { RuntimePermissionPolicy } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

// Keep registration and bridge admission in sync. Restricted modes require an
// execution boundary that can enforce scope and the selected reviewer.
export const NANO_GPT_PERMISSION_MODES = ["full"] as const;

const deniedToolName = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_-]+$/u);
export const toolControlsSchema = z.object({
  disallowedTools: z.array(deniedToolName).max(512).default([]),
  confirmToolCalls: z.boolean().default(false),
});
export type ToolControls = Readonly<z.infer<typeof toolControlsSchema>>;

export function configuredToolDenials(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const input = z.string().max(16_384).parse(value);
  return toolControlsSchema.shape.disallowedTools.parse([...new Set(input.split(/[,\s]+/u).filter(Boolean))]);
}

export function unsupportedPermissionPolicy(policy: RuntimePermissionPolicy): string | null {
  if (NANO_GPT_PERMISSION_MODES.some((mode) => mode === policy.permissionMode)) return null;
  return `NanoGPT does not support permission mode "${policy.permissionMode}". Only full mode is supported; workspace scope and automatic approval review are not implemented.`;
}
