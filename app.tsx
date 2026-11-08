import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SETTINGS_POPUP_ID } from "./src/provider-id.js";
import { SettingsGear } from "./src/settings-gear.js";
import { SettingsPopup } from "./src/settings-popup.js";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "nanogpt-settings",
    actions: [{ id: "gear", component: SettingsGear }],
    plusMenu: [
      {
        id: "nanogpt-settings",
        label: "NanoGPT settings…",
        description: "Set or change the NanoGPT API key.",
        icon: "Settings",
        run: ({ composer }) => {
          composer.experimental_openPopup(SETTINGS_POPUP_ID);
        },
      },
    ],
    experimental_popups: [
      {
        id: SETTINGS_POPUP_ID,
        label: "NanoGPT settings",
        component: SettingsPopup,
      },
    ],
  });
});
