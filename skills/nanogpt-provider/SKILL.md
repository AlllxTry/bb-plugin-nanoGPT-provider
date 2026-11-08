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
names are never forwarded to bb. Reasoning effort uses Provider default; the
plugin does not expose ineffective low/medium/high controls or send unverified
effort parameters across all routed models.

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

## Constraints

- Only the full permission mode is offered.
- The provider has no fork, archive, rename, manual compaction or service tier.
  It uses whole-turn context trimming rather than automatic summarization.
- Conversation history lives in the bridge process and is lost when the host
  daemon restarts. A resumed thread starts with an empty model context.
- One turn runs per thread at a time. Stopping a turn ends it with one
  interrupted event and drops queued follow-up messages, while retaining its
  in-memory conversation context. Release/replacement discards that session.
- The local fallback context budget is 32768 estimated tokens, including a 4096
  output reserve in its calculation. It is not a verified window for every model.
  Current turns and assistant/tool pairs remain intact; older turns are excluded
  with a notice. Stored assistant/tool text is bounded to 24000 UTF-8 bytes.
- Failed input before useful output/tools is not kept in future API history.
  Partial answers and already executed tool results survive later failures.
- For unmatched/late tool-reply diagnostics, NANOGPT_DEBUG_BRIDGE=1 in the bridge
  environment enables generic stderr messages without payloads or keys. Late
  replies after Stop/replacement are expected and still cannot revive a turn.
