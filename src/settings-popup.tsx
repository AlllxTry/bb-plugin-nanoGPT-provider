import { useState, type KeyboardEvent } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { STATE_LABEL, useKeyStatus } from "./key-status.js";
import type { nanoGptSettingsContract } from "./settings-contract.js";

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm text-foreground focus-visible:border-ring/50 focus-visible:outline-none";
const QUIET_BUTTON_CLASS =
  "rounded-md px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** The key form, opened by the gear or the + menu row. */
export function SettingsPopup() {
  const composer = useComposer();
  const rpc = useRpc<typeof nanoGptSettingsContract>();
  const { status, refresh } = useKeyStatus();
  const [apiKey, setApiKey] = useState("");
  const [baseUrlEdit, setBaseUrlEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const baseUrl = baseUrlEdit ?? status?.baseUrl ?? "";
  const accepted = status?.state === "valid";

  /**
   * This is deliberately not a <form>. The popup is mounted inside the
   * composer, which sits in a form of its own; a nested form's submit would
   * be handled by the browser (a page reload) instead of by this code.
   */
  async function save() {
    if (busy || apiKey.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("saveKey", {
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
      });
      setMessage(result.message);
      if (result.saved) {
        setApiKey("");
        setBaseUrlEdit(null);
        refresh();
      }
    } catch (error) {
      setMessage(errorText(error, "Could not save the key."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await rpc.call("clearKey", null);
      setMessage("Key removed.");
      refresh();
    } catch (error) {
      setMessage(errorText(error, "Could not remove the key."));
    } finally {
      setBusy(false);
    }
  }

  function saveOnEnter(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    void save();
  }

  return (
    <div
      role="group"
      aria-label="NanoGPT settings"
      className="flex w-80 max-w-full flex-col gap-3 p-3 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">NanoGPT</span>
        <span className={accepted ? "text-muted-foreground" : "text-warning"}>
          {status === null ? "Checking..." : STATE_LABEL[status.state]}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={apiKey}
          disabled={busy}
          placeholder={accepted ? "Paste a new key to replace it" : "sk-..."}
          onChange={(event) => setApiKey(event.target.value)}
          onKeyDown={saveOnEnter}
          className={INPUT_CLASS}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Base URL (optional)</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          disabled={busy}
          placeholder="https://api.nano-gpt.com/api/v1"
          onChange={(event) => setBaseUrlEdit(event.target.value)}
          onKeyDown={saveOnEnter}
          className={INPUT_CLASS}
        />
      </label>

      {message === null ? null : (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={busy || status?.state === "none"}
          onClick={() => void remove()}
          className={QUIET_BUTTON_CLASS}
        >
          Remove key
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => composer.experimental_closePopup()}
            className={QUIET_BUTTON_CLASS}
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || apiKey.trim() === ""}
            className="rounded-md bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Checking..." : "Save"}
          </button>
        </div>
      </div>

      <a
        href="https://nano-gpt.com/api"
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Get a NanoGPT API key
      </a>
    </div>
  );
}
