import { z } from "zod";

export const HISTORY_TOOL_NAME = "nanogpt_restore_history";
export const HISTORY_PAGE_SIZE = 25;
export const MAX_HISTORY_PAGES = 400;
export const INPUT_NOT_RETAINED_NOTICE = " This input was not kept in the model history; revise it and try again.";

// Stored in bb's turn/completed.providerCheckpointId; contains no prompt text.
const CHECKPOINT_PREFIX = "nanogpt-context-v1:";
const contextCheckpointSchema = z.object({
  requestId: z.string().nullable(),
  inputRetained: z.boolean(),
});
export type ContextCheckpoint = z.infer<typeof contextCheckpointSchema>;

export function encodeContextCheckpoint(value: ContextCheckpoint): string {
  return CHECKPOINT_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeContextCheckpoint(value: unknown): ContextCheckpoint | null {
  if (typeof value !== "string" || !value.startsWith(CHECKPOINT_PREFIX)) return null;
  // A corrupt or foreign checkpoint must never break the whole thread: a
  // resumed session falls back to pre-checkpoint legacy reconstruction
  // instead of failing on every turn.
  try {
    return contextCheckpointSchema.parse(JSON.parse(Buffer.from(value.slice(CHECKPOINT_PREFIX.length), "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export const historyPageRequestSchema = z.object({
  afterSeq: z.number().int().nonnegative().nullable(),
  throughSeq: z.number().int().nonnegative().nullable(),
  currentRequestId: z.string().nullable(),
});

export const historyPageSchema = z.object({
  version: z.literal(1),
  threadId: z.string(),
  throughSeq: z.number().int().nonnegative(),
  nextAfterSeq: z.number().int().nonnegative().nullable(),
  events: z.array(z.unknown()),
});

export type HistoryPageRequest = z.infer<typeof historyPageRequestSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
