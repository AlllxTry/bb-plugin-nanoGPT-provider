---
name: nanogpt-provider
description: "Set up and troubleshoot the NanoGPT provider plugin: API key, base URL, and why NanoGPT models do not appear."
---

# NanoGPT provider

The NanoGPT provider runs bb threads on models served by NanoGPT's
OpenAI-compatible API. It has no CLI command of its own. It is configured with
plugin settings.

## Where the user sets it up

The composer has a gear for NanoGPT (also a "NanoGPT settings..." row in the `+`
menu). It opens a form for the API key and base URL. The form checks the key
with NanoGPT before saving it, so a rejected key is never stored. Point the user
to it first; the commands below are the alternative.

## Settings

- `apiKey` (secret): the NanoGPT API key. NanoGPT models appear only after
  NanoGPT accepts it.
- `baseUrl`: optional API base URL. Empty means
  `https://api.nano-gpt.com/api/v1`. HTTPS is required except for HTTP on
  localhost, 127.0.0.1 or [::1]. Credentials, query strings and fragments in a
  base URL are rejected, as are authenticated redirects.
- `disallowedTools`: exact tool names separated by commas or whitespace. The
  provider-options channel carries these denials on every submitted turn, so
  they work even when bb omits the native session denylist. No wildcards.
- `confirmToolCalls`: boolean, false by default. Enable under Tool controls in the
  popup, or through `bb plugin config`, for one-time manual tool approvals.

Read or change them with the core plugin commands:

```
bb plugin config nanogpt-provider
bb plugin config nanogpt-provider set apiKey <key>
bb plugin config nanogpt-provider set baseUrl <url>
bb plugin reload nanogpt-provider
```

Never print the API key or paste it into a thread. Ask the user to save it in
the plugin settings.

## When NanoGPT shows no models

1. Check that `apiKey` is set: `bb plugin config nanogpt-provider`.
2. A key that NanoGPT rejects (HTTP 401 or 403) gives no models. Ask the user to
   create a new key at https://nano-gpt.com/api.
3. After changing settings, run `bb plugin reload nanogpt-provider`.
4. Read the plugin log with `bb plugin logs nanogpt-provider`.

## Files and attachments

In bb 0.49.0 a NanoGPT thread has no file or shell tools of its own, unlike
providers that bring their own. It only has the tools bb offers every provider.
If the user wants the model to read a file, ask them to attach it with the
paperclip or add-file button. Text files are sent to the model inline, up to
100000 bytes, read asynchronously with safe UTF-8 truncation. Binary/unreadable
files are described as unavailable, with a reason such as file not found or
permission denied. Local PNG/JPEG/GIF/WebP images are sent as data URLs: up to
5000000 bytes each and 10000000 bytes combined. A vision-capable model is required.

## Planning and reasoning

Use `/plan` for a planning turn. The bridge sends a planning instruction and no
tool definitions, and also rejects unexpected tool calls in the response. A
subsequent ordinary turn can use the tools registered by bb again. Unknown tool
names are never forwarded to bb. Reasoning defaults to Provider default. The
live catalog exposes Low, Medium, or High only when NanoGPT declares that
effort for the selected model. Explicit selections are validated before the
request and sent as `reasoning_effort`; Provider default omits the field. Old
saved `medium` selections keep their former Provider default meaning. If a
model's capabilities cannot be verified, Provider default remains available.

The bridge returns authoritative picker options, so missing or malformed metadata
clears old explicit choices. If cached metadata rejects an explicit selection, it
refreshes once before failing. An unsupported effort is never silently downgraded.
The selection remains fixed across the turn's tool rounds and HTTP retries.
Detailed discovery and its optional basic-list fallback share one 10-second
deadline. See `docs/REASONING_EFFORT.md` for the complete behavior and open checks.

## Errors the user may see

- "reached its output length limit": the reply was cut off. Ask the model to
  continue, or use a model with a larger limit.
- "stream ended before the answer was complete": send the message again.
- HTTP 402: the account has no balance, or the model is not in the subscription
  and is billed from the balance.
- "current turn exceeds the local context budget": reduce current input or
  attachments. Older whole turns are removed automatically if that is sufficient.
- A timeout: model listing is bounded to 10 seconds; completion headers and idle
  reads to 120 seconds. The turn fails clearly and can be retried by the user.
- Settings status unavailable: use Retry in the popup. The gear and + menu remain
  setup paths. Close discards unsaved fields rather than saving them.
- An invalid model ID: choose a non-empty ID of at most 512 characters without
  control characters. Availability of a syntactically valid ID is checked upstream.
- "does not declare ... reasoning effort": choose Provider default or an offered
  level, or refresh the catalog. Support depends on the model, endpoint and key.
- A history-restoration error: the resumed turn stops before generation. Check
  plugin logs and the bb event API; do not describe the turn as having resumed
  with complete context when restoration failed.

## Constraints

- Only the full permission mode is offered.
- bb's four permission-policy fields are retained in immutable per-request
  snapshots. `accept-edits` and `auto` are rejected before execution; do not claim
  workspace isolation or automatic approval review support. Registered dynamic
  tools work in full mode. Exact `disallowedTools` entries are enforced when
  supplied. The plugin setting additionally carries denials through public
  provider options, without requiring native-field forwarding. Duplicate
  names reject session construction. The hidden history tool cannot be called
  by the model; missing/denied retrieval fails resume before generation. The
  optional `confirmToolCalls` setting requests manual `tool_use` approval in full
  mode. Only one-time allows without a scope grant execute. Stop and stale replies
  cannot authorize execution. The SDK's 280-character review limit can cause
  large calls to be refused; do not describe that refusal as successful execution.
  `approvalEnforcedBy: "runtime"` does not supply an automatic reviewer.
  See `docs/PERMISSIONS_AND_TOOLS.md` for the audit and implementation constraints.
- The provider has no fork, archive, rename, manual compaction or service tier.
  It uses whole-turn context trimming rather than automatic summarization.
- Active model context lives in the bridge process. After `thread/resume`, the
  first active turn reads bounded saved bb events through a hidden tool before
  generation. Accepted prompts, assistant text, URL images and normalized tool
  interactions are reconstructed; historical tools are never executed again.
  Local historical attachments become filename placeholders. Retrieval failure
  fails the turn instead of continuing with empty context. The scan permits at
  most 400 pages of 25 events; real daemon-restart verification remains open.
- One turn runs per thread at a time. Stopping a turn ends it with one
  interrupted event and drops queued follow-up messages, while retaining its
  in-memory conversation context. A dropped follow-up that was already
  accepted is reported with a visible warning rather than vanishing silently.
  Release/replacement discards that session.
- The context budget comes from the model's advertised context window when the
  catalog provides a sane one (minus a 4096-token output reserve); otherwise a
  local fallback of 32768 estimated tokens applies, with 28672 for input. It is
  not a verified window for every model. Current turns and assistant/tool pairs
  remain intact; older turns are excluded with a notice, and oversized tool
  replies produced inside the current turn are shortened in place to 2000
  characters before the turn is rejected. Stored assistant/tool text is bounded
  to 24000 UTF-8 bytes.
- A transport failure while a request is in flight is never replayed (a POST
  could bill twice); only provably pre-send failures (DNS, refused, unreachable)
  are retried. Server `Retry-After` waits above 120 seconds fail the request
  instead of parking the turn.
- Failed input before useful output/tools is not kept in future API history.
  Partial answers and already executed tool results survive later failures.
- For unmatched/late tool-reply diagnostics, NANOGPT_DEBUG_BRIDGE=1 in the bridge
  environment enables generic stderr messages without payloads or keys. Late
  replies after Stop/replacement are expected and still cannot revive a turn.

Reasoning overrides and history restoration are part of release 0.1.6; the
retry, context-budget, restoration-retry and reasoning-stream fixes described
above are part of release 0.1.7. Do not claim either for an older tagged
installation without checking its version/source. Synthetic tests do not
establish live composer/API compatibility.
