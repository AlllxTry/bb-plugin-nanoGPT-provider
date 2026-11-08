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
  `https://api.nano-gpt.com/api/v1`.

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
100000 bytes. Binary files and local images are only described to the model, not
sent.

## Errors the user may see

- "reached its output length limit": the reply was cut off. Ask the model to
  continue, or use a model with a larger limit.
- "stream ended before the answer was complete": send the message again.
- HTTP 402: the account has no balance, or the model is not in the subscription
  and is billed from the balance.

## Constraints

- Only the full permission mode is offered.
- The provider has no fork, archive, rename, compaction or service tier.
- Conversation history lives in the bridge process and is lost when the host
  daemon restarts. A resumed thread starts with an empty model context.
- One turn runs per thread at a time. Stopping a turn ends it with one
  interrupted event and drops queued follow-up messages.
