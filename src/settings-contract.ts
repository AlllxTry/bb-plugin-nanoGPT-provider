import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeBaseUrl } from "./base-url.js";

export { REALTIME_KEY_STATE_CHANNEL } from "./provider-id.js";

export const apiKeyStateSchema = z.enum(["none", "valid", "invalid", "unknown"]);

export type NanoGptKeyState = z.infer<typeof apiKeyStateSchema>;

const baseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      if (value === "") {
        return true;
      }
      try {
        normalizeBaseUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Use HTTPS, or HTTP on localhost, 127.0.0.1 or [::1], without credentials, query or fragment." },
  );

const statusSchema = z
  .object({
    state: apiKeyStateSchema,
    baseUrl: z.string(),
  })
  .strict();

export type NanoGptStatus = z.infer<typeof statusSchema>;

/**
 * The frontend data plane for the composer gear. The API key only ever travels
 * from the form to the server: no method returns it.
 */
export const nanoGptSettingsContract = defineRpcContract({
  getStatus: {
    input: z.null(),
    output: statusSchema,
  },
  saveKey: {
    input: z
      .object({
        apiKey: z.string().trim().min(1).max(512),
        baseUrl: baseUrlSchema,
      })
      .strict(),
    output: z
      .object({
        saved: z.boolean(),
        state: apiKeyStateSchema,
        message: z.string(),
      })
      .strict(),
  },
  clearKey: {
    input: z.null(),
    output: statusSchema,
  },
});
