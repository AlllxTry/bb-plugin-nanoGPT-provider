// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { nanoGptSettingsContract } from "./src/settings-contract.js";
import { NANO_GPT_PROVIDER_ID, SETTINGS_POPUP_ID } from "./src/provider-id.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const customization = app.composerCustomizations[0]!;
const gear = customization.actions![0]!;
const popup = customization.experimental_popups![0]!;

const NONE = { state: "none" as const, baseUrl: "" };
const VALID = { state: "valid" as const, baseUrl: "" };

function renderGear(args: {
  status: typeof NONE | typeof VALID;
  providerId?: string;
}) {
  return renderSlot(
    gear,
    {},
    {
      experimental_rpcContract: nanoGptSettingsContract,
      rpc: {
        getStatus: () => args.status,
        saveKey: () => ({ saved: true, state: "valid", message: "ok" }),
        clearKey: () => NONE,
      },
      composer: {
        selection:
          args.providerId === undefined
            ? undefined
            : { providerId: args.providerId },
      },
    },
  );
}

describe("the NanoGPT composer registration", () => {
  it("registers a gear, a + menu row and the settings popup under one id", () => {
    expect(customization.plusMenu?.map((item) => item.id)).toEqual([
      "nanogpt-settings",
    ]);
    expect(popup.id).toBe(SETTINGS_POPUP_ID);
  });

  it("opens the settings popup from the + menu row", () => {
    const opened: string[] = [];
    customization.plusMenu![0]!.run({
      composer: { experimental_openPopup: (id: string) => opened.push(id) } as never,
    });
    expect(opened).toEqual([SETTINGS_POPUP_ID]);
  });
});

describe("the gear", () => {
  it("shows before any key is saved, so setup is reachable", async () => {
    const view = renderGear({ status: NONE });
    expect(await view.findByLabelText("NanoGPT settings")).toBeTruthy();
  });

  it("hides once the key is accepted and NanoGPT is not the selected provider", async () => {
    const view = renderGear({ status: VALID, providerId: "codex" });
    await vi.waitFor(() =>
      expect(view.inspection.rpcCalls.map((call) => call.method)).toContain(
        "getStatus",
      ),
    );
    await vi.waitFor(() =>
      expect(view.queryByLabelText("NanoGPT settings")).toBeNull(),
    );
  });

  it("stays when NanoGPT is the selected provider", async () => {
    const view = renderGear({ status: VALID, providerId: NANO_GPT_PROVIDER_ID });
    expect(await view.findByLabelText("NanoGPT settings")).toBeTruthy();
  });
});

describe("the settings popup", () => {
  function renderPopup(rpc: Record<string, (input: never) => unknown> = {}) {
    return renderSlot(
      popup,
      {},
      {
        experimental_rpcContract: nanoGptSettingsContract,
        rpc: {
          getStatus: () => NONE,
          saveKey: () => ({ saved: true, state: "valid", message: "Key accepted." }),
          clearKey: () => NONE,
          ...rpc,
        } as never,
      },
    );
  }

  it("sends the typed key and shows NanoGPT's verdict", async () => {
    const saveKey = vi.fn(() => ({
      saved: false,
      state: "invalid" as const,
      message: "NanoGPT rejected this API key. Check it and try again.",
    }));
    const view = renderPopup({ saveKey });
    const input = (await view.findByPlaceholderText("sk-…")) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "  sk-typed  " } });
    fireEvent.click(view.getByText("Save"));
    await vi.waitFor(() =>
      expect(saveKey).toHaveBeenCalledWith({ apiKey: "sk-typed", baseUrl: "" }),
    );
    expect(await view.findByText(/rejected this API key/)).toBeTruthy();
  });

  it("clears the field after a key is accepted", async () => {
    const view = renderPopup();
    const input = (await view.findByPlaceholderText("sk-…")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-good" } });
    fireEvent.click(view.getByText("Save"));
    expect(await view.findByText("Key accepted.")).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("is not a <form>, because bb mounts it inside the composer's own form", async () => {
    const view = renderPopup();
    await view.findByPlaceholderText("sk-…");
    expect(view.container.querySelector("form")).toBeNull();
    const save = view.getByText("Save").closest("button") as HTMLButtonElement;
    expect(save.type).toBe("button");
  });

  it("saves when Enter is pressed in the key field, without submitting anything", async () => {
    const saveKey = vi.fn(() => ({
      saved: true,
      state: "valid" as const,
      message: "Key accepted.",
    }));
    const view = renderPopup({ saveKey });
    const input = await view.findByPlaceholderText("sk-…");
    fireEvent.change(input, { target: { value: "sk-enter" } });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter" });
    expect(notPrevented).toBe(false);
    await vi.waitFor(() =>
      expect(saveKey).toHaveBeenCalledWith({ apiKey: "sk-enter", baseUrl: "" }),
    );
  });

  it("ignores Enter while the key field is empty", async () => {
    const saveKey = vi.fn(() => ({
      saved: true,
      state: "valid" as const,
      message: "Key accepted.",
    }));
    const view = renderPopup({ saveKey });
    const input = await view.findByPlaceholderText("sk-…");
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("keeps Save disabled until a key is typed", async () => {
    const view = renderPopup();
    const save = (await view.findByText("Save")).closest("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
