# Changelog

All notable changes to this plugin. Versions follow the `vX.Y.Z` git tags that bb
reads when you install or update the plugin.

## Unreleased

- Documentation only: the README and the agent skill now describe attachments,
  stop behaviour, the missing file tools and the extra error messages.

## 0.1.3

- Attached text files are read and sent to the model inline, up to 100000 bytes
  per file. Before, only a name placeholder was sent and the model guessed at the
  contents. Binary files and files that cannot be read are described to the model
  as unavailable.
- Every turn ends with exactly one terminal event (`completed`, `interrupted` or
  `failed`). Stopping a turn closes open tool and text items, answers unanswered
  tool calls in the model history, and still ends with `interrupted` if the
  request does not honour the abort.
- A pending tool call is cancelled on stop, and a late tool result is ignored.
- One turn runs per thread at a time. A second message is queued and acknowledged
  once, and a queued follow-up is dropped when the turn is stopped.
- Token usage is summed over every model round, and timeline item ids are unique
  per round.
- A tool call whose arguments are not valid JSON is not run; the model gets an
  error and can retry.
- A stream that ends before NanoGPT signals completion, or that is cut off by the
  model's output length limit, fails the turn instead of showing a partial
  answer. A cut-off tool call is never run.
- A request that the transport leaves hanging, before or after the response
  headers, is released on abort. A response that arrives after the stop is
  cancelled.
- The bridge no longer advertises session restore, because its conversation
  history lives in memory only.

## 0.1.2

- New icon, used for the plugin and for the NanoGPT provider in the picker.

## 0.1.1

- Documentation: a "Support the project" section, and a fix for a broken code
  fence that made the end of the README render as one code block.

## 0.1.0

- First release: the NanoGPT provider with streaming text and reasoning, tool
  calling, a live model catalog and an API key gate. No key that NanoGPT accepts
  means no models.
- A gear in the composer, and a `+` menu row, that open a small form for the key
  and an optional base URL. The key is checked with NanoGPT before it is saved.
- The key is a secret plugin setting that no RPC method returns.
