import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { nanoGptHostContract } from "./contract.js";

export { experimental_providerBridge } from "./src/provider-bridge.js";

export default experimental_defineHostEntry({
  contract: nanoGptHostContract,
  handlers: {
    hostInfo: (_input, context) => ({
      platform: process.platform,
      dataDir: context.experimental_paths.dataDir,
    }),
  },
});
