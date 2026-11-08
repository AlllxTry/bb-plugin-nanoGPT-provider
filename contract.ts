import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const nanoGptHostContract = defineRpcContract({
  hostInfo: {
    input: z.object({}).strict(),
    output: z
      .object({ platform: z.string(), dataDir: z.string() })
      .strict(),
  },
});
