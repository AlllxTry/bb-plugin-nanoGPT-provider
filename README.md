# bb-plugin-nanoGPT-provider

A [bb](https://github.com/get-bb/bb) **agent provider plugin** that connects bb to
[NanoGPT](https://nano-gpt.com/api), an OpenAI-compatible API serving a live model
catalog.

Install the plugin, paste your NanoGPT API key into the plugin settings, and
**NanoGPT appears in bb's provider picker with the live model catalog**. Until a
key that NanoGPT accepts is saved, the provider offers **no models at all**.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.
This README describes the current source tree, released as package version 0.1.6.

Detailed references:

- [Reasoning effort: selections, discovery, cache, failures, and verification](docs/REASONING_EFFORT.md)
- [Conversation-history API audit and restoration constraints](docs/BB_HISTORY_API_AUDIT.md)
- [Permission policy, approval routing, and tool support audit](docs/PERMISSIONS_AND_TOOLS.md)

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Reasoning effort](#reasoning-effort)
- [How the API key gate works](#how-the-api-key-gate-works)
- [Turn lifecycle, planning and failures](#turn-lifecycle-planning-and-failures)
- [Permissions and tools](#permissions-and-tools)
- [Context and attachment limits](#context-and-attachment-limits)
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
  - image URLs and local PNG/JPEG/GIF/WebP attachments sent as `image_url` parts
    (choose a model with vision support).
- **Attached text files** (the paperclip or add-file button) are read by the plugin
  and sent to the model inline, up to 100000 bytes per file.
- **Live model catalog** from `GET /models?detailed=true` with a basic-list
  fallback for endpoints rejecting detailed mode, listed only for a key that NanoGPT
  has authenticated.
  The default model is `openai/gpt-6.1-sol` when available. The complete catalog
  is returned, with preferred models first and duplicates removed.
- **Plan mode** through `/plan`: the model receives a planning instruction and
  no tools. The bridge also blocks unexpected tool calls returned in that mode.
- **Bounded conversation context**: oldest completed turns are removed with a
  visible notice when the local input budget is exceeded; tool calls and their
  replies stay together.
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
- **Steering and interruption**: only one turn runs per thread at a time, so a
  follow-up message sent mid-turn is queued and acknowledged once. `thread/stop`
  aborts the in-flight request, cancels a pending tool call, closes any open tool
  item as interrupted, drops queued follow-ups, and ends the turn with exactly one
  `interrupted` event. An API request that never answers is released too.
- **Configurable base URL** to point at any other OpenAI-compatible endpoint
  (for example NanoGPT's `/api/v1legacy`).
- Built on the **public plugin SDK only** (`@get-bb/plugin-sdk`), with no
  first-party privileges.

## Requirements

| Requirement | Version / note                                                      |
| ----------- | ------------------------------------------------------------------- |
| bb          | 0.49 or newer (`engines.bb`), with the `bb` CLI. Tested on 0.49.0.   |
| Node.js     | 22.19 or newer, for tests and typecheck (bb bundles its own)        |
| NanoGPT key | Create one at <https://nano-gpt.com/api>                            |
| Plugin SDK  | `@get-bb/plugin-sdk` `>=0.6.133` (declared in `engines.bbPluginSdk`) |

## Quick start

### Install from GitHub

bb can install the plugin straight from Git. bb builds it on your machine, so you
need no clone and no build step:

```bash
bb plugin install git:https://github.com/AlllxTry/bb-plugin-nanoGPT-provider.git@^0.1.4
bb plugin update nanogpt-provider      # later, to pick up a newer release
```

The `@^0.1.4` part follows the repository's `vX.Y.Z` release tags, so
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
| `disallowedTools` | string | empty | Exact tool names separated by commas or whitespace. No wildcards. |
| `confirmToolCalls` | boolean | false | Require one-time user approval for ordinary model tool calls. |

Open **Tool controls** in the NanoGPT settings popup to edit the denylist and
confirmation setting without changing the API key. The same settings are available
through bb's plugin configuration commands:

```bash
bb plugin config nanogpt-provider set disallowedTools "read_file,write_file"
bb plugin config nanogpt-provider set confirmToolCalls true
```

Each submitted turn receives a settings snapshot. Changes apply to newly
submitted turns, including resumed threads; they do not retroactively change a
running turn or an already queued prompt.

Custom endpoints must use HTTPS. HTTP is accepted only for `localhost`,
`127.0.0.1` and `[::1]`, for example `http://localhost:8080/v1`. URLs containing
credentials, query strings or fragments are rejected. The same check applies to
the settings form, settings changed through bb, provider options and environment
overrides. Authenticated requests reject redirects; configure the final endpoint
directly instead of relying on a redirect.

Model IDs are trimmed and checked before a request: they must be non-empty, no
longer than 512 characters, and contain no control characters. Validation allows
provider-specific IDs rather than restricting models to a static allowlist. A
syntactically valid model can still be unavailable to your account; that error
comes from the upstream API.

NanoGPT documents `https://api.nano-gpt.com/api/v1legacy` as a base URL for
clients that fail on reasoning output. Set it as `baseUrl` if you hit that.

## Reasoning effort

Every model offers **Provider default**, which omits `reasoning_effort` from the
API request. The picker also offers Low, Medium, or High when the detailed catalog
declares that exact level for the selected model. Explicit Medium is distinct
from Provider default. Old saved bare `medium` values retain their previous
Provider default meaning after an upgrade.

Missing, malformed, conflicting, or basic-only metadata produces a default-only
picker. Its records are authoritative to bb so previously discovered explicit
options can be cleared. Explicit selections are validated before generation; a
cached rejection gets one fresh catalog lookup before the turn fails. The bridge
does not silently reduce an explicit selection or retry it with effort removed.

The chosen effort is fixed for the turn and reused across tool continuations and
HTTP retries. Visible reasoning is streamed separately when returned; its presence
or length does not verify which effort reached the API. See the
[detailed reasoning guide](docs/REASONING_EFFORT.md) for wire IDs, cache behavior,
errors, implementation locations, and remaining verification.

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
5. Valid/invalid verdicts are cached for 60 seconds; temporary unknown verdicts
   for 5 seconds. Concurrent checks for the same normalized endpoint and key
   share a request. The cache holds at most 64 identities indexed by SHA-256
   digests, without storing raw keys in map/set keys. Settings changes clear
   cached verdicts and prior trust; a successful save remembers the key just
   verified. Late checks cannot restore credentials removed in the meantime.
6. When NanoGPT can't be reached (verdict *unknown*), a key that was accepted
   earlier in the same session keeps working. A key that was never checked does
   not.

The plugin also contributes a health message to bb: while a key is accepted, bb
can show that it is using the key saved in the plugin settings. When no key is
saved, the plugin marks itself as needing configuration. Maintenance requests
do not carry current credentials in SDK 0.6.133: the bridge returns a baseline
requiring setup, and bb overlays it with the server's credential-health
contribution. The bridge never decides readiness from a stale process API key.

If the settings status RPC fails, the gear remains available. The popup shows an
error and a Retry action instead of staying on “Checking...”. Closing the popup
clears the unsaved key, base URL draft and transient message; it does not change
the saved settings.

## Turn lifecycle, planning and failures

Each session runs one turn at a time. A message submitted during a running turn
waits in the queue. Stop drops the queued follow-ups and interrupts the active
turn, closing its open timeline items and answering pending model tool calls
with cancellation results. The in-memory session remains available for the next
turn. Stop on an idle session is harmless; release or session replacement frees
that conversation context.

`/plan` applies only to the submitted planning turn. Its system instruction is
rebuilt for the next turn, so a subsequent ordinary turn can use tools again.
The bridge omits tool definitions in planning requests and refuses to execute
any tool calls unexpectedly returned by the upstream. In ordinary turns, only
tools registered by bb for that session can execute. Unknown names receive a
local tool error and are never forwarded to bb.

If the API rejects a request before useful model output or tool calls, the
failed input is excluded from future model requests and the error says so.
The visible failed message is not deleted from bb. A later failure cannot erase
tools already executed: completed calls/results and partial answers are retained
in model history. Streaming error payloads preserve the upstream error details.
Length-limited and content-filtered responses fail explicitly, preserving visible
partial text and never executing calls from the incomplete/blocked response.

The model list has a 10-second deadline covering fetch and response-body parsing,
shared by detailed discovery and its optional basic fallback.
Completion headers and individual stream reads have 120-second deadlines. The
stream idle deadline restarts with each read and does not run while the bridge
waits for a tool result or the consumer pauses between reads. A timeout fails the
turn; a user Stop interrupts it. Connections and local file operations are
cancelled on a best-effort basis, while late results cannot change a settled turn.

Reasoning defaults to **Provider default**. The live model catalog exposes
explicit Low, Medium, or High choices only when NanoGPT declares those values
for that model. Explicit choices are sent as `reasoning_effort` and rejected
locally if the model does not advertise them. Provider default omits the
parameter, including for older saved turns whose `medium` value meant the
provider default. Models without verified effort metadata remain available at
the upstream default. Reasoning deltas are streamed separately when returned.

### Automatic request retries

Each completion request allows at most four attempts: the initial request and
three retries. Before a successful HTTP response starts streaming, HTTP 429,
502, 503, and 504 responses and transport failures can trigger a retry. Other
HTTP errors, user cancellation, and request or response-body timeouts fail
immediately. Once a successful response starts streaming, a broken or incomplete
stream fails the turn instead of replaying the request. Model-list requests do
not use this completion retry policy.

For every retryable HTTP status, `Retry-After` takes precedence over the local
backoff. Both non-negative integer seconds (`Retry-After: 60`) and HTTP dates
(`Retry-After: Mon, 09 Nov 2026 00:01:00 GMT`) are supported. A future date waits
until that time; zero seconds or an elapsed date adds no delay. Malformed values
fall back to the local backoff. Without a usable header, retry waits are about
2, 4, and 8 seconds, each with up to 500 ms of jitter; local backoff is capped at
10 seconds. A transport failure uses local backoff rather than reusing a header
from an earlier response.

Server-directed waits can exceed the local 10-second cap. Long waits are split
into intervals supported by the runtime, and Stop can cancel the wait without
sending another request. The 120-second request/read deadlines apply to network
operations, not to the retry wait; there is no overall retry deadline. After
four retryable HTTP failures, the reported error retains the final upstream
status and message and includes the attempt count. For example:
`NanoGPT API error 429: Daily quota exhausted (after 4 attempts)`.

## Permissions and tools

The provider currently offers only `full` permission mode. bb sends
`permissionMode`, `permissionScope`, `approvalReviewer`, and
`permissionEscalation` to the bridge, and the SDK validates their combination.
The bridge retains the complete validated policy in an immutable per-request
snapshot, including queued turns. `accept-edits` and `auto` are rejected on
start, resume, turn start, and steer before input acknowledgement, session
replacement, history reads, attachment reads, or model requests. Workspace
isolation and automatic approval review are not implemented. Manual confirmation
is available independently through `confirmToolCalls` in full mode.

Dynamic tools still work: the bridge advertises bb's session tools to NanoGPT
and forwards registered calls to bb. It blocks unknown names, malformed
arguments, and ordinary model tool execution in plan mode. Session
`disallowedTools` uses exact names: denied tools are omitted from model requests
and blocked if the model returns their names anyway. Duplicate tool names reject
session construction without replacing an existing session. The hidden history
tool can be called only by restoration logic; denying or omitting it makes
resume fail before generation. The inspected bb runtime adapter does not forward
`disallowedTools` in normal session construction, so this bridge check applies
when the field is supplied. The plugin's **Disallowed tools** setting also works
through normal bb dispatch: its validated names travel in public provider options
on every request. Both denylists apply, and provider options cannot remove a
native session denial. Direct top-level denylist forwarding still needs a bb
adapter change; the settings path does not depend on it.

**Confirm tool calls** is off by default. When enabled, each eligible ordinary
call sends a public `interaction/request` with a `tool_use` approval before
execution. Only `allow_once` with no permission grant is accepted. Denials, service
errors, malformed replies, Stop, release, and session replacement prevent execution;
late replies are ignored. A later call requires a new approval. Internal read-only
history restoration does not prompt and still obeys both denylists.

The review redacts fields whose names identify credentials. SDK 0.6.133 limits
approval detail to 280 characters: a call whose complete redacted review does not
fit is refused, rather than shown with truncated arguments. This can prevent large
tool calls while confirmation is enabled. Approval is an additional full-mode
confirmation, not a workspace sandbox or an automatic reviewer. Individual tools
may apply their own controls.

The plugin supplies no general file-editing or shell tools. Permission settings
do not add them. See the [detailed audit](docs/PERMISSIONS_AND_TOOLS.md) for the
field matrix, source evidence, available Git history, and verification limits.
The implementation plan and progress are a local development document at
`dev_docs/PERMISSIONS_AND_TOOLS_PLAN.md`; the existing Git ignore rules exclude
that directory from releases.

## Context and attachment limits

The catalog client retrieves IDs and optional reasoning metadata, without verified
model context limits. The bridge therefore uses a local policy of 32,768 estimated
tokens, with 4,096 reserved in the budget calculation and 28,672 available for
input. This is not a claim that every model has that window, and the reservation
does not set an upstream output-token limit. Smaller models can still reject a
request; there is no automatic unchanged retry or paid summarization request.

Before every model round, the estimate covers system/instruction text, multipart
text, tool definitions, tool-call arguments and tool replies. Text is estimated
from UTF-8 bytes at roughly three bytes per token, plus per-message overhead.
Each image uses a fixed 2,048-token allowance rather than counting its base64
characters. These are approximate budgeting values, not a tokenizer or an
image-resolution-based cost estimate. Usage reported by the API always takes
precedence; fallback usage separately estimates generated text, reasoning and
tool-call output for each round.

When necessary, the bridge removes the oldest complete turns from model history,
keeping the system message and the current turn intact. An assistant tool-call
message is never separated from its tool replies. A visible notice explains that
older context was excluded; the conversation displayed in bb remains intact.
If the current turn alone exceeds the budget, it fails locally before another
API request. Large assistant/tool outputs retained in history are bounded to
24,000 UTF-8 bytes, keeping the beginning and end with a truncation marker.
Visible streamed text and tool results are not replaced by that shortened copy.

Text attachments are read asynchronously, up to 100,000 bytes per file. Truncation
does not split a trailing UTF-8 character. Empty files are labelled explicitly;
binary and unreadable files are described as unavailable. Read failures distinguish
missing files, permissions, non-regular files, resource exhaustion and filesystem
I/O errors without exposing the full local path in the generated description.
Only host-supplied attachment inputs are read; a path merely mentioned in prose
does not cause a file read.

Local images are read asynchronously and encoded as data URLs. PNG, JPEG, GIF
and WebP MIME types are identified from the bytes, with a 5,000,000-byte per-image
limit and a 10,000,000-byte combined limit per prompt for embedded/local image
data. Remote image URLs are forwarded without downloading them locally. Vision
support is model-dependent: choose a vision-capable model. A rejected image
request before useful output is removed from future model history by the same
failed-input recovery rule.

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
- **`server.ts`** runs inside the bb server. It owns settings, the settings RPC,
  provider registration and the key gate. It also registers a hidden, read-only
  tool that retrieves the active thread's saved events for restoration. Saving a
  key checks it with NanoGPT first and only stores a key that NanoGPT accepts.
- **`host.ts`** is bundled into `dist/host.js` and run by the bb host daemon. It
  exports the provider bridge, which is where the agent loop lives.
- **The bridge** (`src/provider-bridge.ts`) speaks bb's provider bridge protocol
  (grammar v3). For each turn it streams a chat completion, runs any tool calls
  through bb (`item/tool/call` requests), appends the results, and loops until
  the model returns a final answer or the 40-round limit is hit. Every turn ends
  through one settle step, which closes open items and sends a single terminal
  event (`completed`, `interrupted` or `failed`).

After `thread/resume`, the first active turn retrieves history through the hidden
`nanogpt_restore_history` tool and reconstructs context before appending the new
prompt or calling NanoGPT. The tool is excluded from model-advertised tools and
ordinary model dispatch. A failed scan fails the turn; it does not silently start
with empty history. The bridge currently advertises `sessionRestore: true` and
`sessionRestorable: true`; real daemon-restart verification remains outstanding.

## Project layout

```
.
|-- server.ts                  # Plugin entry (bb.server): settings, settings RPC, provider, key gate
|-- app.tsx                    # Frontend entry (bb.app): composer gear, + menu row, settings popup
|-- host.ts                    # Host entry (bb.host): bridge + host RPC
|-- contract.ts                # Host RPC contract (hostInfo)
|-- src/
|   |-- api-key-gate.ts        # Key validation + verdict cache
|   |-- attachments.ts         # Reads attached text files for the model
|   |-- base-url.ts            # Shared endpoint validation and normalization
|   |-- context.ts             # Context budgeting, whole-turn eviction, bounded outputs
|   |-- history-adapter.ts     # Saved event -> model-message reconstruction
|   |-- history-protocol.ts    # History pages, scan limits, input-retention checkpoints
|   |-- key-status.ts          # Frontend hook: key state from RPC + realtime
|   |-- nano-gpt-client.ts     # HTTP client: SSE streaming, tool-call assembly, models
|   |-- provider-bridge.ts     # Bridge: sessions, turns, tool loop, JSON-RPC
|   |-- provider-id.ts         # Provider, channel and popup ids shared by server and app
|   |-- permissions.ts         # Shared supported modes and policy admission errors
|   |-- tool-approval.ts       # Approval result validation and bounded, redacted reviews
|   |-- tool-settings.tsx      # Lazy-loaded tool controls in the composer popup
|   |-- reasoning.ts           # Effort IDs, supported subsets, compatibility and validation
|   |-- settings-contract.ts   # RPC contract: getStatus, saveKey, clearKey
|   |-- settings-gear.tsx      # The composer gear
|   |-- settings-popup.tsx     # The key form
|   `-- vocabulary.ts          # Constants, provider options schema, helpers
|-- *.test.ts, src/*.test.ts   # Unit tests (vitest)
|-- assets/icon.svg            # Plugin and provider icon (single-colour vector, themed by bb)
|-- skills/nanogpt-provider/SKILL.md  # Setup and troubleshooting notes for agents, shipped with the plugin
|-- PLUGIN_OVERVIEW.md         # Text for the marketplace page
|-- CHANGELOG.md               # What changed in each release
|-- docs/REASONING_EFFORT.md    # Reasoning behavior, cache policy and acceptance gaps
|-- docs/BB_HISTORY_API_AUDIT.md # History API evidence and restoration constraints
|-- docs/PERMISSIONS_AND_TOOLS.md # Permission fields, approval routing and tool gaps
|-- package.json               # The plugin manifest lives under the "bb" key
|-- tsconfig.json
|-- vitest.config.ts
`-- LICENSE
```

| File                     | Responsibility                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/nano-gpt-client.ts` | `streamChatCompletion` (SSE parsing, text and reasoning deltas, tool-call fragments, usage), `listModels`, typed `NanoGptApiError`. |
| `src/provider-bridge.ts` | Session map, turn queue, steering, stop and interrupt, `settleTurn` (the single place a turn ends), thread delta emission, tool round loop, model list, health. |
| `src/attachments.ts`     | `describeAttachedFile`: inlines attached text files for the model, describes binary, unreadable and over-long ones honestly. |
| `src/api-key-gate.ts`    | `checkApiKey` (valid, invalid or unknown) and `createApiKeyGate` (verdict cache and offline behaviour).                           |
| `src/vocabulary.ts`      | Provider id (`nano-gpt`), default base URL, env var names, default model, `MAX_TOOL_ROUNDS`.                                      |

## Development

```bash
npm install            # install dependencies
npm test               # run the unit tests
npm run typecheck      # tsc --noEmit
npm run build          # bb plugin build . -> dist/server.js, dist/app.js, dist/host.js
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
| Client       | SSE streaming of text, reasoning, tool-call fragments and usage; HTTP error mapping; model list parsing; aborting a read or a fetch that never returns; cancelling a response that arrives after the abort; cut-off streams. |
| Bridge       | Grammar v3, model lists and reasoning selection, tool continuation, API errors, queue/steering, health, usage, unique items, cancellation and late-response isolation, attachments, planning guards, failed-input recovery, and lazy history retrieval before resumed generation. |
| Reasoning policy | Namespaced explicit IDs, legacy default compatibility, conservative metadata normalization, per-model choices and unsupported-selection errors. Review-fix regression and live acceptance gaps are tracked in the detailed reasoning guide. |
| Permissions | Unsupported policies rejected before effects or acknowledgement; invalid/duplicate session replacement preserves the active session; exact tool denials, hidden-history dispatch isolation, and resume failures before generation. |
| Tool controls | Settings -> public provider options -> bridge denials; one-time approval, invalid/denied replies, Stop/release/replacement, late replies, independent queued settings, secret redaction, SDK presentation limits, and popup/RPC saving without a key. |
| History adapter | Accepted input, retry and queue ordering, current-request exclusion, context clears, retained/rolled-back input, normalized tool reconstruction, and unavailable historical attachments. |
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
| 402 or "No balance" errors                           | Your NanoGPT account is out of balance, or the model is not in your subscription and is billed from the balance. Top it up on nano-gpt.com or pick another model. |
| The model says it cannot read a file, or guesses     | Attach it with the paperclip/add-file button. Text is inlined; local PNG/JPEG/GIF/WebP images are sent to vision-capable models. Binary files are described as unavailable. |
| "current turn exceeds the local context budget"     | Reduce the current input, attachments or instructions. Older completed turns are removed automatically when that is sufficient. |
| "stream timed out" or no response headers in time    | The endpoint stalled. Retry the turn or check the configured endpoint. Stop remains available while requests are pending. |
| Settings show "Unavailable"                         | Click Retry. Setup remains reachable through the gear and the composer's + menu. |
| A previously offered effort is rejected              | Refresh the model catalog or choose Provider default. Support must be verified for the current model, endpoint and key; cached rejection triggers one fresh lookup. |
| Only Provider default appears                       | The model declares no implemented levels, or detailed metadata is absent, malformed, conflicting or unavailable through a basic-only endpoint. |
| Resume fails with a history error                    | Read plugin logs and check the hidden history tool / bb events API. Retrieval failures stop generation; a changed boundary, malformed page, stalled cursor or scan limit can reject restoration. |
| "reached its output length limit"                    | The model stopped because its reply hit the output limit. Ask it to continue, or pick a model with a larger limit.  |
| "stream ended before the answer was complete"        | NanoGPT closed the connection early. Send the message again.                                                       |

Plugin logs: `bb plugin logs nanogpt-provider`.

For late/unmatched tool-response diagnostics, set `NANOGPT_DEBUG_BRIDGE=1` in the
host bridge environment. Diagnostics go to stderr and contain a generic reason
only, without tool payloads, response IDs, arguments or keys. Late responses after
Stop/replacement are expected and remain ignored. Normal mode does not log them;
stdout remains reserved for JSON-RPC.

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
- The plugin sends your prompts, tool results, attached text files and attached
  images to NanoGPT, or to whatever `baseUrl` you set. It reads an attached file
  only from the path bb stages for the thread, up to 100000 bytes, and no other
  file. Review NanoGPT's privacy terms before use.
- NanoGPT keys are checked with `POST /api/check-balance`; custom endpoints use
  an authenticated models request. HTTPS/loopback policy and redirect rejection
  apply to both key checks and model requests.

## Limitations

- bb remains the persistent source of conversation history. On the first turn
  after `thread/resume`, the provider reads saved bb events before sending the
  new prompt to NanoGPT. It restores accepted user prompts, assistant text and
  normalized tool interactions; historical tools are never re-executed. URL
  images are restored, while unavailable historical local attachments become
  filename placeholders. Original NanoGPT request grouping and tool-call IDs
  are not stored in bb's event history. The event scan is bounded to 400 pages
  of 25 events. A live provider/daemon restart has not yet been verified.
  Interrupting a turn preserves the active in-memory session; releasing it
  discards provider memory while bb retains the conversation.
- Input rejected before any usable model output or tool calls is excluded from
  subsequent requests, with an error explaining that it was not retained. Partial
  answers and executed tool results are preserved after later failures. Errors
  reported within an SSE stream include the upstream error message.
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
- Cancelling a turn also ends a request that the transport leaves hanging, whether
  it stalls before the response headers or in the middle of the body, so a stuck
  request cannot keep the turn alive. This releases the turn, not the transport:
  cancellation of the underlying connection is best effort and cannot be forced.
  A response that arrives after the stop is cancelled and never reaches the
  timeline. A follow-up that was queued when the turn is stopped is dropped.
- Token estimates and image allowances are approximate; see the context section.
  Usage that NanoGPT reports is used as is. The local fallback budget cannot
  guarantee compatibility with every routed model's context window.
- Tool calls whose arguments are not valid JSON are not run; the model gets an
  error and can retry.
- bb gives a NanoGPT thread no file or shell tools of its own (checked in bb 0.49.0 with
  the full permission mode): the agent only has the dynamic tools bb offers, such as
  asking a question or running a workflow. Providers such as Codex or Claude Code
  bring their own file tools; this one does not. Attach a file to let the model read
  it.
- Tool-result images are not sent back into the model context.
- Attached text files (the paperclip or add-file button) are read by the plugin and
  sent to the model inline, up to 100000 bytes per file; a longer file is cut and
  the model is told so. Binary files and files that cannot be read are described
  to the model as unavailable, never guessed at. Local images are sent as data
  URLs within the documented image limits; model vision support is required.
- The reasoning picker only offers effort levels declared for the selected
  model. Models without verified effort metadata use Provider default.
- Only the `full` permission mode is offered. There is no fork, archive, rename,
  manual compaction or service tier support.
- The complete model list is returned, with preferred models first.
- Model descriptions are generic, and context-window sizes are not reported.
- Mobile and web clients have not been tested.
- Historical v0.1.3 checks in live bb (0.49.0, Windows): the plugin installed and ran, the
  `nano-gpt` provider is registered, the gear and the settings form appear in the
  composer, a rejected key is not saved, a real key is accepted by NanoGPT, and
  the server then loads a catalog of 400 models. With no key the picker offers no
  models.
- Smoke-tested before v0.1.3 in that live bb with a real key, driven through the bb
  CLI (`bb thread spawn`, `tell` and `stop`) and read back from the thread event
  log, not through the app window. Installing over the previous version kept the
  saved key. A plain turn and a tool call each ended with one terminal event. Stop
  during streaming, during a running tool call and during a hung API request each
  ended with one `interrupted` event and closed the tool item as interrupted. A
  message sent mid-turn was acknowledged once, a thread started after a Stop got
  none of the stopped thread's events, and an attached text file was read
  correctly. The tool-call checks used bb's own tools and a temporary slow test
  tool, so file tools were not exercised. Streaming with reasoning content was
  not seen live.
- The v0.1.4 changes are covered by unit/integration tests, type checking
  and a plugin build. New live bb/API smoke checks have not been run; the historical
  checks above do not validate the new behavior against a real model.

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
