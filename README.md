# bb-plugin-nanoGPT-provider

A [bb](https://github.com/get-bb/bb) **agent provider plugin** that connects bb to
[NanoGPT](https://nano-gpt.com/api), one OpenAI-compatible API in front of
1,000+ models.

Install the plugin, paste your NanoGPT API key into the plugin settings, and
**NanoGPT appears in bb's provider picker with the live model catalog**. Until a
key that NanoGPT accepts is saved, the provider offers **no models at all**.

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How the API key gate works](#how-the-api-key-gate-works)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Development](#development)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [Support the project](#support-the-project)
- [Author](#author)
- [License](#license)

---

## Features

- **Full agent loop** against NanoGPT's `POST /chat/completions`:
  - streaming responses (SSE) with separate **text** and **reasoning** channels,
  - **tool calling** through bb's dynamic tools, with multi-round tool use
    (up to 40 rounds per turn),
  - token **usage** reporting,
  - image inputs passed through as `image_url` parts.
- **Live model catalog** from `GET /models`, listed only for a key that NanoGPT
  has authenticated.
  The default model is `openai/gpt-6.1-sol`, and the first 400 models are shown.
- **API key gate**: models and credentials are unavailable until NanoGPT accepts
  the key (see [below](#how-the-api-key-gate-works)).
- **A gear in the composer** that opens a small settings form where you paste
  the key, optionally set a base URL, and remove the key. You don't have to go to
  Plugins to set the plugin up. The key is checked with NanoGPT before it is
  saved, so a wrong key is never stored. The same form is in the composer's `+`
  menu as "NanoGPT settings...".
- **Key stored as a secret setting**: bb keeps it in a `0600` file under the
  plugin data dir, never in the database. No RPC method returns it, so the
  frontend can write the key but never read it back.
- **Steering and interruption**: follow-up messages sent mid-turn are queued, and
  `thread/stop` aborts the in-flight request.
- **Configurable base URL** to point at any other OpenAI-compatible endpoint
  (for example NanoGPT's `/api/v1legacy`).
- Built on the **public plugin SDK only** (`@get-bb/plugin-sdk`), with no
  first-party privileges.

## Requirements

| Requirement | Version / note                                                      |
| ----------- | ------------------------------------------------------------------- |
| bb          | Desktop app or server with the plugin system and the `bb` CLI       |
| Node.js     | 22.19 or newer, for tests and typecheck (bb bundles its own)        |
| NanoGPT key | Create one at <https://nano-gpt.com/api>                            |
| Plugin SDK  | `@get-bb/plugin-sdk` `>=0.6.133` (declared in `engines.bbPluginSdk`) |

## Quick start

### Install from GitHub

bb can install the plugin straight from Git. bb builds it on your machine, so you
need no clone and no build step:

```bash
bb plugin install git:https://github.com/AlllxTry/bb-plugin-nanoGPT-provider.git@^0.1.0
bb plugin update nanogpt-provider      # later, to pick up a newer release
```

The `@^0.1.0` part follows the repository's `vX.Y.Z` release tags, so
`bb plugin update` only moves to compatible releases. Then continue with the
steps under "Then, in bb" below.

### Build from source

```bash
# 1. Get the code and dependencies
git clone https://github.com/AlllxTry/bb-plugin-nanoGPT-provider.git
cd bb-plugin-nanoGPT-provider
npm install

# 2. Make sure bb is running (start the desktop app, or your bb server)

# 3. Build the plugin and install it into bb
npm run build
npm run install:bb        # = bb plugin install . --yes
```

Then, in bb:

1. Click the **gear** in the composer (it shows while NanoGPT still needs a key,
   and whenever NanoGPT is the selected provider). The same form opens from the
   composer's `+` menu, under "NanoGPT settings...".
2. Paste your **NanoGPT API key** and press **Save**. The plugin checks the key
   with NanoGPT first. A rejected key is not saved.
3. Choose **NanoGPT** in the provider picker and pick a model.

Settings are also available the long way: Settings > Plugins > NanoGPT provider,
or `bb plugin config nanogpt-provider`.

> **Plugin id.** bb derives it from the package name by dropping the
> `bb-plugin-` prefix, so the package `bb-plugin-nanogpt-provider` becomes `nanogpt-provider`. That is the id
> every `bb plugin ...` command in this README uses. `bb plugin list` shows it.

> `bb` must be on your `PATH`. On Windows the desktop installer puts it at
> `%USERPROFILE%\.bb\bin\bb.cmd`. If your terminal can't find `bb`, call it by
> full path or add that folder to `PATH`.

> If `bb plugin install` fails with `Cannot connect to BB server`, bb isn't
> running. Start it and retry.

## Configuration

All configuration lives in the plugin's bb settings. Use the settings UI, or the
CLI:

```bash
bb plugin config nanogpt-provider                         # show settings
bb plugin config nanogpt-provider set apiKey sk-nano-...  # set the key
bb plugin config nanogpt-provider set baseUrl https://api.nano-gpt.com/api/v1legacy
bb plugin config nanogpt-provider unset baseUrl
bb plugin reload nanogpt-provider
```

| Setting   | Type            | Default | Description                                                                              |
| --------- | --------------- | ------- | ---------------------------------------------------------------------------------------- |
| `apiKey`  | string (secret) | none    | Your NanoGPT API key. Required. NanoGPT models appear only after the key is accepted.    |
| `baseUrl` | string          | empty   | Override the API base URL. Empty means `https://api.nano-gpt.com/api/v1`.                |

NanoGPT documents `https://api.nano-gpt.com/api/v1legacy` as a base URL for
clients that fail on reasoning output. Set it as `baseUrl` if you hit that.


## How the API key gate works

The goal: **no valid key, no models.**

1. The plugin reads `apiKey` from its settings.
2. It asks NanoGPT whether the key is accepted, with a 4-second timeout. It calls
   `POST /api/check-balance` with the key in the `x-api-key` header. It does
   **not** use `GET /models`, because NanoGPT answers that endpoint with HTTP 200
   even when the key is missing or wrong, so it proves nothing.
   - **HTTP 200**: the key is valid.
   - **HTTP 401 or 403**: the key is rejected.
   - **Network error, timeout, or any other status**: the verdict is unknown.

   If `baseUrl` points at a host other than `nano-gpt.com`, there is no
   `check-balance` endpoint to call. The plugin then falls back to an
   authenticated `GET <baseUrl>/models`, which only proves that the endpoint
   answers, so use the default URL if you want real key validation.
3. Only a **valid** key is handed to the provider. bb does this by contributing it
   as an environment variable (`NANOGPT_API_KEY`) to the NanoGPT bridge process.
4. The bridge lists models **only** if it received a key. With no key it answers
   `model/list` with an empty list, and a turn fails with a message that points
   at the plugin settings.
5. Verdicts are cached for 60 seconds. The cache is cleared whenever a plugin
   setting changes, so pasting a new key takes effect right away.
6. When NanoGPT can't be reached (verdict *unknown*), a key that was accepted
   earlier in the same session keeps working. A key that was never checked does
   not.

The plugin also contributes a health message to bb: while a key is accepted, bb
can show that it is using the key saved in the plugin settings. When no key is
saved, the plugin marks itself as needing configuration.

## Architecture

The plugin has four parts, mirroring bb's provider plugin model:

```
+----------------------- bb app (browser) --------------------+
| app.tsx                                                     |
|  - composer gear, + menu row, settings popup                |
|  - writes the key through RPC; can never read it back       |
+------------------------------+------------------------------+
                               | RPC: getStatus, saveKey, clearKey
+------------------------- bb server -------------------------+
| server.ts                                                   |
|  - defines settings (apiKey, baseUrl) and the settings RPC  |
|  - registers the "nano-gpt" provider (no fallback models)   |
|  - API key gate -> contributes the NANOGPT_API_KEY env      |
+------------------------------+------------------------------+
                               | env + provider options
+------------------------- host daemon ----------------------+
| host.ts  (bb.host artifact, built to dist/host.js)          |
|  - exports the provider bridge (JSON-RPC over stdio)        |
|  - exports a small host RPC entry (hostInfo)                |
+------------------------------+------------------------------+
                               | HTTPS, Bearer token
                      +--------v---------+
                      |   NanoGPT API    |
                      |   /models        |
                      |   /chat/completions
                      +------------------+
```

- **`app.tsx`** is the frontend, bundled to `dist/app.js`. It adds the gear, the
  `+` menu row and the settings popup to bb's composer. It only talks to the
  server through three RPC methods, and none of them returns the key.
- **`server.ts`** runs inside the bb server. It owns the settings, the settings
  RPC, the provider registration and the key gate. It never sees conversation
  content. Saving a key checks it with NanoGPT first and only stores a key that
  NanoGPT accepts.
- **`host.ts`** is bundled into `dist/host.js` and run by the bb host daemon. It
  exports the provider bridge, which is where the agent loop lives.
- **The bridge** (`src/provider-bridge.ts`) speaks bb's provider bridge protocol
  (grammar v3). For each turn it streams a chat completion, runs any tool calls
  through bb (`item/tool/call` requests), appends the results, and loops until
  the model returns a final answer or the 40-round limit is hit.

## Project layout

```
.
|-- server.ts                  # Plugin entry (bb.server): settings, settings RPC, provider, key gate
|-- app.tsx                    # Frontend entry (bb.app): composer gear, + menu row, settings popup
|-- host.ts                    # Host entry (bb.host): bridge + host RPC
|-- contract.ts                # Host RPC contract (hostInfo)
|-- src/
|   |-- api-key-gate.ts        # Key validation + verdict cache
|   |-- key-status.ts          # Frontend hook: key state from RPC + realtime
|   |-- nano-gpt-client.ts     # HTTP client: SSE streaming, tool-call assembly, models
|   |-- provider-bridge.ts     # Bridge: sessions, turns, tool loop, JSON-RPC
|   |-- provider-id.ts         # Provider, channel and popup ids shared by server and app
|   |-- settings-contract.ts   # RPC contract: getStatus, saveKey, clearKey
|   |-- settings-gear.tsx      # The composer gear
|   |-- settings-popup.tsx     # The key form
|   `-- vocabulary.ts          # Constants, provider options schema, helpers
|-- *.test.ts, src/*.test.ts   # Unit tests (vitest)
|-- assets/icon.svg            # Plugin and provider icon (single-colour vector, themed by bb)
|-- package.json               # The plugin manifest lives under the "bb" key
|-- tsconfig.json
|-- vitest.config.ts
`-- LICENSE
```

| File                     | Responsibility                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/nano-gpt-client.ts` | `streamChatCompletion` (SSE parsing, text and reasoning deltas, tool-call fragments, usage), `listModels`, typed `NanoGptApiError`. |
| `src/provider-bridge.ts` | Session map, turn queue, steering, stop and interrupt, thread delta emission, tool round loop, model list, health.                |
| `src/api-key-gate.ts`    | `checkApiKey` (valid, invalid or unknown) and `createApiKeyGate` (verdict cache and offline behaviour).                           |
| `src/vocabulary.ts`      | Provider id (`nano-gpt`), default base URL, env var names, default model, `MAX_TOOL_ROUNDS`.                                      |

## Development

```bash
npm install            # install dependencies
npm test               # run the unit tests
npm run typecheck      # tsc --noEmit
npm run build          # bb plugin build .  -> dist/server.js, dist/host.js
npm run install:bb     # bb plugin install . --yes
npm run dev            # bb plugin dev .   -> rebuild and reload on every change
```

Notes:

- `npm run build` and the other `bb plugin ...` scripts need the `bb` CLI on your
  `PATH`. Install and dev also need a running bb.
- The plugin is installed **from its local path**. After editing sources, run
  `npm run build` and `bb plugin reload nanogpt-provider`, or use `npm run dev` to do both
  on every change.
- The SDK's test helpers import `better-sqlite3`, `cron-parser` and `hono`, so
  they are listed as dev dependencies. `better-sqlite3` needs its install script
  to run, and npm 12 blocks install scripts by default. `package.json` already
  carries an `allowScripts` entry for it. If the native module is missing, run
  `npm rebuild better-sqlite3`.
- The upstream bb monorepo typechecks with `tsrs`, which has no Windows build.
  This repo uses the regular TypeScript compiler.

## Testing

The suite runs with `vitest` and the SDK's testing helpers. No test touches the
network, because `fetch` is stubbed. `npm test` prints the current test count.

```bash
npm test
```

| Area         | What is covered                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Client       | SSE streaming of text, reasoning, tool-call fragments and usage; HTTP error mapping; model list parsing.                 |
| Bridge       | `initialize`, a full tool round, API errors, steering, health, model listing with and without a key, a turn with no key, usage summed over rounds, unique item ids, invalid tool arguments, stop during a pending tool call (item closed as interrupted), a hung request on stop (released by the abort, and another thread still runs), queued turns, one acknowledgement per steered input, cut-off and length-limited streams, no restore claim. |
| API key gate | valid, invalid and unknown verdicts, verdict caching, offline behaviour, re-check after a clear.                         |
| Registration | provider declaration, env passthrough, and no env contribution without a saved key.                                      |
| Settings RPC | a rejected or unreachable key is not saved; an accepted key is saved, announced over realtime and contributed as env; no result ever contains the key; a bad base URL is refused. |
| Composer UI  | the gear shows before setup and for the selected provider, the popup sends the typed key and shows NanoGPT's verdict, the key field is a password field. |
| Host         | one host artifact exports both a provider bridge and a host RPC entry.                                                   |

## Troubleshooting

| Symptom                                              | Likely cause and fix                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| NanoGPT shows no models                              | No key saved, or NanoGPT rejected it. Check the key at nano-gpt.com/api and save it again in the plugin settings. |
| Key saved but models still missing                   | NanoGPT was unreachable and the key was never validated this session. Check connectivity, then reload the plugin. |
| Turn fails with "No NanoGPT API key is configured"   | The bridge received no key. Save a valid key in the plugin settings and reload the plugin.                        |
| `Cannot connect to BB server`                        | bb isn't running, or `BB_SERVER_URL` is wrong. Start bb and retry.                                                |
| `bb` is not recognised                               | Add the bb CLI folder to `PATH`, or call it by full path (`%USERPROFILE%\.bb\bin\bb.cmd` on Windows).             |
| Build error: cannot resolve `@get-bb/plugin-sdk/...` | Run `npm install` first so the SDK is present in `node_modules`.                                                  |
| `server.test.ts` fails with a missing package        | Install the dev dependencies. For `better-sqlite3`, run `npm rebuild better-sqlite3`.                             |
| Client errors on reasoning output                    | Set `baseUrl` to `https://api.nano-gpt.com/api/v1legacy`.                                                         |
| 402 or "No balance" errors                           | Your NanoGPT account is out of balance. Top it up on nano-gpt.com.                                                |

Plugin logs: `bb plugin logs nanogpt-provider`.

## Security notes

- Plugins are **full-trust code** that runs inside the bb server. They can read
  all local bb data, including other plugins' secrets. Install only code you
  trust, and read this repo before you do.
- The API key is a **secret setting**: bb stores it in a `0600` file under the
  plugin data directory, not in its database, and never sends it to the frontend.
- The key is passed to the NanoGPT bridge process as an environment variable. bb
  reports provider environment values as-is in its **"Provider environment
  resolved"** diagnostic events, so the key can appear there when diagnostics are
  enabled. Treat diagnostic logs as sensitive.
- The plugin sends your prompts, tool results and attached images to NanoGPT, or
  to whatever `baseUrl` you set. Review NanoGPT's privacy terms before use.
- The key is validated against NanoGPT only, with `POST /api/check-balance`.

## Limitations

- Conversation history lives in the bridge process only. The bridge does not
  advertise session restore, so a thread resumed after a restart starts with an
  empty model context.
- Only one turn runs per thread at a time; a second message sent while a turn
  runs is queued.
- A stream that ends before NanoGPT signals completion fails the turn instead of
  showing a partial answer. A reply cut off by the model's output length limit
  (`finish_reason: length`) also fails the turn with a clear message, and a tool
  call cut off that way is never run.
- Every turn ends with exactly one terminal event. Stopping a turn closes any
  tool item that was still running as interrupted and answers its tool call in
  the model history. A stop that the request does not honour in time still ends
  with an interrupted event.
- A queued follow-up message is acknowledged once, when it arrives.
- Cancelling a turn also ends a response read that the transport leaves hanging,
  so a stuck request cannot keep the turn or its stream alive.
- When NanoGPT does not report token usage, the plugin estimates it from the
  conversation text (about four characters per token), once per model round. The
  estimate counts the whole history each round, so it can overstate usage in long
  tool loops. Usage that NanoGPT reports is used as is.
- Tool calls whose arguments are not valid JSON are not run; the model gets an
  error and can retry.
- Tool-result images are not sent back into the model context.
- Local image and file attachments are sent as a text placeholder (their path or
  name), not their contents.
- The reasoning-level picker (low, medium, high) is **not** forwarded to the API
  as `reasoning_effort`, because some routed providers reject it.
- Only the `full` permission mode is offered. There is no fork, archive, rename,
  manual compaction or service tier support.
- The model list is capped at 400 entries, with a few preferred models first.
- Model descriptions are generic, and context-window sizes are not reported.
- Mobile and web clients have not been tested.
- Checked in a live bb (0.49.0, Windows): the plugin installs and runs, the
  `nano-gpt` provider is registered, the gear and the settings form appear in the
  composer, a rejected key is not saved, a real key is accepted by NanoGPT, and
  the server then loads a catalog of 400 models. With no key the picker offers no
  models. The author also ran a live agent request against NanoGPT with a real
  key and the API key check on plugin versions 0.1.0 to 0.1.2. The turn-lifecycle
  fixes after 0.1.2 (queued turns, cancelled tool calls, summed usage, cut-off
  streams) are covered by unit tests with a stubbed `fetch` and have not been
  re-run live yet.

## Support the project

This plugin is free and MIT licensed. If it saves you time, you can support its
author with a donation in crypto. Thank you.

| Asset | Network           | Address                                      |
| ----- | ----------------- | -------------------------------------------- |
| BTC   | Bitcoin           | `13BEg3VPxsiSfLhKNM1GnXEmy6kz23ybYz`         |
| ETH   | Ethereum (ERC-20) | `0x94e35bfeee8f9d0338994acda2c9e8d7e3d9779d` |
| USDT  | Tron (TRC-20)     | `TS9mfjWxhEtXt8omkyd3cUyvZmp1YBfJwW`         |
| USDT  | Ethereum (ERC-20) | `0x94e35bfeee8f9d0338994acda2c9e8d7e3d9779d` |

- Send each asset only on the network named in its row. A transfer on the wrong
  network, for example USDT on Tron to the Ethereum address, cannot be recovered.
- ETH and USDT on Ethereum use the same address.
- Copy an address from this repository only. A copy on another site could have
  been altered.
- Donations are voluntary. They do not buy support and do not change the license.

## Author

Oleksander Trybushnyi

## License

[MIT](./LICENSE) (c) 2026 Oleksander Trybushnyi

