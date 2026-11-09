# Changelog

All notable changes to this plugin. Versions follow the `vX.Y.Z` git tags that bb
reads when you install or update the plugin.

## Unreleased

- Cap server-directed `Retry-After` waits at 120 seconds for completion retries.
  A header beyond the cap fails the request immediately with the upstream status
  preserved instead of parking a turn for minutes or hours; waits within the cap
  are still honoured past the Node.js timer limit and remain cancellable by Stop.
  Documented the cap in the README retry policy (the "no overall retry deadline"
  claim no longer applies).
- Stop replaying completion POSTs after in-flight transport failures. DNS
  resolution, connection-refused and unreachable-route errors are retried because
  the request provably never reached the server; any other transport failure
  (reset socket, hang-up after send) fails the turn with an explanatory message
  instead of risking a billed duplicate request.
- Derive the input token budget from the model's advertised `context_length` when
  the detailed catalog provides a sane one (minus a 4,096-token output reserve,
  capped at ten million advertised tokens). Models without usable metadata keep
  the local 32,768-token fallback. When evicting old whole turns is not enough,
  tool replies already produced inside the current turn are shortened in place
  to 2,000 characters (oldest first, with a visible marker) before the turn is
  rejected, so multi-round tool use no longer fails at four 24 KB results.
  Eviction accounting is now incremental instead of re-estimating the whole
  history per eviction.
- Make history restoration self-healing. A corrupt or foreign checkpoint value in
  bb turn events now decodes to a legacy/no-checkpoint reconstruction instead of
  throwing, and one failed history read fails only its own turn: the sticky
  restoration requirement is cleared, so later turns on the same resumed thread
  continue with the current input instead of failing forever.
- Open a reasoning timeline item before streaming its first reasoning text delta
  (previously reasoning `textDelta`s had no preceding `item.open`), and stream the
  reasoning channel before the answer text when both arrive together.
- Flush the streaming UTF-8 decoder when the SSE body ends so a trailing
  multi-byte character split across the final chunks is not dropped.
- Report `model/list` failures to the host as a JSON-RPC error instead of a
  silently empty catalog, resolve the picker endpoint from provider options
  before env (matching turn requests), and drop the redundant unique-by-id pass.
- Answer already-acknowledged queued follow-ups with a visible provider warning
  when Stop drops them, instead of discarding them silently. A terminal boundary
  is deliberately not emitted for them because it would corrupt the history
  collector's turn grouping.
- Tolerate a saved base URL that is not a valid endpoint (for example one saved
  through a path this plugin does not validate): `getStatus`, env contribution
  and provider-option derivation ignore it with a log line and fall back to the
  default endpoint instead of failing.
- Separate adjacent text parts in a prompt (message + attached file, or two
  attachments) with blank lines in the live path and in restored history, so
  they cannot fuse into one another.
- Verification: 290 tests across 13 files pass, including new regressions for
  the retry cap, the no-replay rule, catalog context windows, in-turn tool
  compaction, the restoration retry-clear, reasoning item opening, model/list
  error reporting and endpoint resolution; `tsc --noEmit` passes.

## 0.1.6 — 2026-11-09

- Fix the provider handshake so bb can list NanoGPT models again. The bridge
  reported `capabilities.grammarVersions` as `[3]`, but the SDK contract is an
  ascending `[min, max]` pair, so the host rejected `initialize` with
  "capabilities.grammarVersions: Too small: expected array to have >=2 items"
  and the model picker showed "Could not load models for NanoGPT." The bridge now
  reports `[3, 3]`.
- Add a regression test that validates the advertised capabilities against the
  SDK's `bridgeCapabilitiesSchema`. Verification: 281 tests, typecheck, plugin
  build, local reinstall, and `bb provider models nano-gpt` returning the live
  catalog.

## 0.1.5 — 2026-11-09

- Add a Tool controls panel and independent RPCs for exact tool denials and
  optional one-time manual confirmations. Carry validated controls in public
  provider options so configured denials work without bb forwarding the native
  denylist. Preserve each submitted turn's settings snapshot. Validate approval
  replies with the SDK contract, reject broader grants and malformed/error replies,
  cancel on Stop/release/replacement, ignore late responses, and redact credential
  fields in reviews. Refuse reviews that cannot fit the SDK's 280-character
  presentation limit. Automatic review and workspace confinement remain unsupported.
  Verification: 280 tests, typecheck, build, and four offline built-host protocol
  smoke scenarios passed. Live approval UI/daemon behavior remains unverified.
- Preserve bb's complete permission policy in immutable per-request options and
  reject unsupported modes before acknowledging input or changing sessions.
  Keep the advertised modes limited to full until workspace/reviewer enforcement
  is available. Enforce exact session tool denials in model definitions and
  dispatch, reject duplicate names, and restrict the hidden history tool to
  bridge restoration. Missing/denied history retrieval stops resumed generation.
  Add 31 regression tests; the inspected bb adapter still needs denylist
  forwarding, and general approval review remains unsupported.
- Document the permission/tool audit: full-only capability declaration, dropped
  policy fields, ignored session tool denylist, and separate tool/approval routing.
  Record that dynamic tools still work and available Git history shows these
  permission gaps from the initial commit. Reproduce the gaps with 17 isolated
  local audit probes, including queued turns and resumed history retrieval.
  Follow-up behavior fixes are described above.
- Honor `Retry-After` seconds and HTTP dates for every retryable completion
  status (429, 502, 503, 504), keep long waits cancellable without timer overflow,
  and use local backoff after a subsequent transport failure. Exhausted HTTP
  retries preserve the final upstream status/message and include the attempt
  count. Add retry regression coverage and document the retry policy.
- Add model-specific Low, Medium, and High reasoning effort choices when NanoGPT
  declares support. Explicit choices are validated and sent as `reasoning_effort`;
  Provider default omits the field and preserves the old saved `medium` behavior.
- Make default-only reasoning records authoritative to bb so stale explicit
  choices are removed after metadata loss. Refresh once when cached metadata
  rejects an explicit effort, and share one model-list deadline across detailed
  discovery and basic fallback. Dedicated regression and live acceptance checks
  remain open; see [the reasoning guide](docs/REASONING_EFFORT.md).
- Restore NanoGPT model context from bb's saved event history after provider
  session resume. History is fetched through a bounded hidden tool before the
  first model request; failed retrieval fails the turn instead of silently
  continuing with empty context. URL images are restored; historical local
  attachment bytes and original model tool-call IDs are not available.
- Add history-adapter and resume-bridge coverage. Live daemon restart verification
  remains outstanding.
- Restore queued prompts in execution order and preserve accepted retry inputs.
  Record request identity and input retention in bb turn checkpoints so rolled-back
  input and canceled queued prompts stay excluded after resume. Retained failed
  and interrupted turns can be evicted together with their tool results.

## 0.1.4 — 2026-11-09

- Interrupting a turn preserves its session and conversation history, including
  when Stop is pressed while idle. Replacing a session cancels its previous
  turn and queue without leaking late output into the new session.
- Failed input is excluded from subsequent requests when the model returned no
  usable output or tool calls. Partial answers and completed tool results are
  preserved after later failures.
- Streamed tool arguments ignore null fragments. Parallel calls without indices
  are matched by id; ambiguous or conflicting fragments fail before execution.
- Errors reported inside an SSE stream retain the upstream error message.
- Empty base URLs are stored as strings, and legacy null settings are read safely.
- Correct default-model selection and preferred-model ordering; return the full
  catalog instead of silently cutting it to 400 entries.
- Plan mode has a composer action, a planning instruction and a strict tool
  execution guard. Unknown tools never reach bb.
- Replace ineffective reasoning choices with one Provider default option; close
  reasoning with accumulated text. Health uses bb's current server credential
  contribution instead of a process API-key snapshot.
- Add a 10-second model-list deadline and 120-second completion header/idle-read
  deadlines, including body reads. Timeouts fail turns instead of interrupting them.
- Require HTTPS except on loopback, validate all endpoint sources consistently,
  and reject authenticated redirects.
- Bound model history with whole-turn eviction and a visible notice; estimate
  multipart/tool input and generated output, and bound stored assistant/tool text.
- Read attachments asynchronously with UTF-8-safe truncation and useful read-error
  categories. Send local PNG/JPEG/GIF/WebP images as bounded data URLs.
- Keep settings reachable after RPC errors, provide Retry and clear drafts on Close.
- Deduplicate and bound credential checks using digest identities, and prevent
  removed credentials from being restored by late results.
- Validate model-ID syntax before sending requests; optionally diagnose unmatched
  tool responses on stderr without logging response data.
- Expand behavior, limitations, recovery, verification and marketplace-release
  documentation. Existing live checks remain historical, not validation of this release.

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
