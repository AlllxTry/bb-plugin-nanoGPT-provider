import { approvalInteractionOutcomeSchema, threadEventItemPresentationSchema, type ThreadEventItemPresentation } from "@get-bb/plugin-sdk/provider-bridge";

const SECRET_FIELD = /api[_-]?key|token|password|secret|authorization|credential|private[_-]?key/iu;
const MAX_REVIEW_BYTES = 12_000;

// No session grants: each request is bound to one invocation and one argument
// snapshot. Missing, malformed, denied, or broader resolutions fail closed.
export function toolApprovalAllowed(result: unknown): boolean {
  const parsed = approvalInteractionOutcomeSchema.shape.resolution.safeParse(result);
  return parsed.success && parsed.data.decision === "allow_once" && parsed.data.grantedPermissions === null;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [
      name, SECRET_FIELD.test(name) ? "[redacted]" : redact(child),
    ]));
  }
  return value;
}

export function toolApprovalPresentation(tool: string, args: Record<string, unknown>): ThreadEventItemPresentation | null {
  // Refuse an oversized ask rather than approving arguments the user could not
  // review. Secret-valued fields are explicitly marked, never silently omitted.
  const raw = JSON.stringify({ tool, arguments: args });
  if (Buffer.byteLength(raw, "utf8") > MAX_REVIEW_BYTES) return null;
  const text = JSON.stringify({ tool, arguments: redact(args) });
  const ticks = Math.max(2, ...[...text.matchAll(/`+/gu)].map(m => m[0].length)) + 1;
  const fence = "`".repeat(ticks);
  const presentation = {
    icon: { glyph: "ShieldCheck" },
    label: { pending: "Awaiting tool approval", completed: "Tool approval reviewed" },
    title: "Approve this tool call once?",
    detail: `Full permissions. Secret fields are marked [redacted].\n\n${fence}json\n${text}\n${fence}`,
  };
  // SDK 0.6.133 limits detail to 280 characters. Never truncate the operation
  // to make it fit: an incomplete ask is not reviewable authorization.
  const validated = threadEventItemPresentationSchema.safeParse(presentation);
  return validated.success ? validated.data : null;
}
