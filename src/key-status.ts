import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { nanoGptSettingsContract } from "./settings-contract.js";
import { REALTIME_KEY_STATE_CHANNEL } from "./provider-id.js";

export type KeyState = "none" | "valid" | "invalid" | "unknown";

export interface Status {
  state: KeyState;
  baseUrl: string;
}

export const STATE_LABEL: Record<KeyState, string> = {
  none: "No API key saved",
  valid: "API key accepted",
  invalid: "NanoGPT rejected the saved key",
  unknown: "Could not reach NanoGPT",
};

export function isStatus(value: unknown): value is Status {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.baseUrl === "string" &&
    (candidate.state === "none" ||
      candidate.state === "valid" ||
      candidate.state === "invalid" ||
      candidate.state === "unknown")
  );
}

/** The current key state, kept fresh by the server's announcements. */
export function useKeyStatus(): { status: Status | null; refresh: () => void } {
  const rpc = useRpc<typeof nanoGptSettingsContract>();
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(() => {
    void rpc
      .call("getStatus", null)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime(REALTIME_KEY_STATE_CHANNEL, (payload) => {
    if (isStatus(payload)) setStatus(payload);
  });
  return { status, refresh };
}
