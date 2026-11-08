import { experimental_Icon as Icon, useComposer } from "@get-bb/plugin-sdk/app";
import { STATE_LABEL, useKeyStatus } from "./key-status.js";
import { NANO_GPT_PROVIDER_ID, SETTINGS_POPUP_ID } from "./provider-id.js";

/**
 * The gear in the composer's action row. It shows while NanoGPT is the
 * selected provider, and also while the key still needs setup, so the way to
 * configure the plugin is visible before any NanoGPT model can be picked.
 */
export function SettingsGear() {
  const composer = useComposer();
  const { status, error } = useKeyStatus();
  const selected = composer.selection?.providerId === NANO_GPT_PROVIDER_ID;
  const needsSetup = status === null || status.state !== "valid" || error !== null;
  if (!selected && !needsSetup) return null;

  return (
    <button
      type="button"
      aria-label="NanoGPT settings"
      title={
        error ?? (status === null
          ? "NanoGPT settings"
          : `NanoGPT settings. ${STATE_LABEL[status.state]}.`)
      }
      onClick={() => composer.experimental_openPopup(SETTINGS_POPUP_ID)}
      className={
        "inline-flex size-7 items-center justify-center rounded-md hover:bg-state-hover " +
        (needsSetup
          ? "text-warning"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      <Icon name="Settings" className="size-4" aria-hidden />
    </button>
  );
}
