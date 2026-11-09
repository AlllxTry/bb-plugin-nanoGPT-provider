import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { nanoGptSettingsContract, ToolSettings } from "./settings-contract.js";

/** Loaded only when expanded, independently of API-key validation. */
export function ToolSettingsPanel() {
  const rpc = useRpc<typeof nanoGptSettingsContract>();
  const [values, setValues] = useState<ToolSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void rpc.call("getToolSettings", null).then(next => {
      if (current) setValues(next);
    }).catch(() => {
      if (current) setError("Could not load tool controls.");
    });
    return () => { current = false; };
  }, [rpc, generation]);

  async function save() {
    if (values === null || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await rpc.call("saveToolSettings", values);
      setValues(next);
      setMessage("Tool controls saved. They apply to newly submitted turns.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save tool controls.");
    } finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-2 border-t border-border pt-2">
    {error === null ? null : <p role="alert">{error}</p>}
    {values === null ? <button type="button" onClick={() => setGeneration(n => n + 1)}>
      {error === null ? "Loading tool controls..." : "Retry tool controls"}
    </button> : <>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={values.confirmToolCalls} disabled={busy}
          onChange={e => { setMessage(null); setValues({ ...values, confirmToolCalls: e.target.checked }); }} />
        Confirm tool calls
      </label>
      <label className="flex flex-col gap-1">
        Disallowed tools
        <textarea rows={3} spellCheck={false} disabled={busy} value={values.disallowedTools}
          placeholder="Exact names, separated by commas or new lines"
          className="rounded-md border border-border bg-surface-raised p-2"
          onChange={e => { setMessage(null); setValues({ ...values, disallowedTools: e.target.value }); }} />
      </label>
      <p className="text-muted-foreground">Confirmation asks once per call. These controls do not add a workspace sandbox.</p>
      <button type="button" disabled={busy} className="rounded-md border border-border px-2 py-1"
        onClick={() => void save()}>{busy ? "Saving tool controls..." : "Save tool controls"}</button>
    </>}
    {message === null ? null : <p role="status">{message}</p>}
  </div>;
}
