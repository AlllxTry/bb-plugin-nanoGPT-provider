# Code review implementation and verification

Implementation review: 8 November 2026. Release packaging: 9 November 2026,
version **0.1.4**. The user authorized committing, pushing and updating marketplace
PR #891. Publication is tracked by the release tag and that PR; this report
records source-level verification without claiming new live API smoke tests.

This report records the implementation of the user's consolidated 26-item plan,
the four findings in `ADDITIONAL_BUGS.md`, the tests supporting the changes and
the limits that remain. It distinguishes code inspected locally from behavior
actually exercised against a running bb installation or real model.

## Inputs and repository boundaries

- `C:/Users/Alex/Downloads/CODE_REVIEW.md`: 24 findings against revision `23ba066`.
- The user's consolidated plan: 26 numbered tasks, followed in `FIX_PLAN.md`.
- `ADDITIONAL_BUGS.md`: four additional findings against the evolving source.
- Installed `@get-bb/plugin-sdk@0.6.133`: schemas, types and SDK event collector.
- Local bb source: credential-health overlay, maintenance request construction,
  provider declaration validation and catalog handling.

Review documents were treated as evidence to verify. Their proposed code was
not copied as an authority. Several proposed fixes needed changes to match the
installed protocol and preserve tool/history invariants.

Implementation and source documentation are in `bb-plugin-nanoGPT-provider`.
The separate `bb-marketplace-submit` repository holds marketplace PR #891 on
`submit-nanogpt-provider`. Its update targets source range `^0.1.4` and copies the
source overview unchanged. The source release/tag must be pushed before that
marketplace branch, so reviewers can resolve and inspect the advertised version.

## Implementation by original plan item

| Item | Result | Evidence / relevant coverage |
|---|---|---|
| 1 | Null tool-argument fragments are ignored instead of becoming text. | A null between two string chunks preserves valid JSON arguments. |
| 2 | Legacy null base URLs are read safely; empty values are stored as strings; the default URL has one definition. | Settings RPC tests exercise status/env reads with legacy null and inspect the persisted empty string. |
| 3 | Unused plugin ID export removed and imports ordered before declarations. | Reference search and TypeScript validation. |
| 4 | Grammar v3 is advertised once. | Initialization response assertion. |
| 5 | Trailing-buffer CR normalization matches complete SSE lines. | Shared parser flow; trailing trim already removed whitespace, so this is consistency cleanup. |
| 6 | Redundant finalUsage alias removed. | Existing real-usage and streaming assertions. |
| 7 | Interrupt retains a session, including idle/repeated Stop; release removes it. | Continue on the same thread after pending-tool cancellation; idle/repeated Stop; release; replacement/Stop race. |
| 8 | Rejected input without usable progress is excluded from future model history. | A rejected request followed by a revised request; preservation of earlier conversation, partial output and executed tool results. |
| 9 | Calls are accumulated by index/id identity, with ambiguity/conflict rejection. | Parallel id-only calls, mixed formats, continuation by id, conflicting identities and missing identifiers. |
| 10 | SSE errors retain upstream details and fail the turn. | Errors before/after text; bridge error text and preservation of partial answer. |
| 11 | Preferred models follow configured order; the intended default is marked explicitly. | Three preferred models, duplicates, absence of the configured default and ordinary-only catalogs. |
| 12 | Plan mode has a composer action, planning instruction, no tool definitions and an execution guard. | Ordinary follow-up restores tools; unexpected plan-mode calls produce no tool RPC. |
| 13 | Unsupported effort choices replaced by one Provider default option. | Provider registration and model metadata agree. No unverified effort override is sent. |
| 14 | Health no longer reads process API-key state. | Stale process-key bridge test; server contribution add/remove test; inspection of bb's health-overlay implementation. |
| 15 | Context is bounded by a local input policy, with whole-turn eviction and a visible notice. | Long multi-turn dialog; preservation of system/current turn and assistant/tool groups; oversized-input recovery. |
| 16 | Model-list/header/body/read waits are bounded, with distinct timeout errors. | Stalled headers, JSON/error body and stream reads; idle reset; paused consumer; bridge timeout is failed rather than interrupted. |
| 17 | All credential endpoint sources use shared validation; authenticated redirects are rejected. | HTTPS/loopback matrix; external HTTP, look-alike localhost, embedded credentials, malformed URLs, query/fragment; settings/env/options paths. |
| 18 | Unknown tools return local errors and are never forwarded to bb. | Unknown tool response, no tool RPC, valid tool-error history in the next model round. |
| 19 | Reasoning closes using accumulated SDK text. | Completed reasoning item with text on success, failure and interruption. |
| 20 | Replaced sessions cancel old work and cannot drain old queues or leak late results. | Replacement through both start and resume, queued work, late replies and Stop/replacement races. |
| 21 | Fallback input/output estimates include multipart text, image allowance, definitions, arguments/results and generated output. | Pure estimator tests and a bridge turn without upstream usage; existing exact upstream-usage assertions still pass. |
| 22 | content_filter fails clearly and cannot run accompanying tool calls. | Partial filtered response carrying a valid-looking call results in no tool RPC. |
| 23 | Local images are encoded as MIME-qualified data URLs. | PNG detected from bytes despite a JPEG extension; rejection of spoofed/large files; bridge request includes local pixels. |
| 24 | Text attachments use async bounded reads, safe UTF-8 truncation and file-handle cleanup. | Small/long/binary/empty/missing/directory inputs, multibyte boundary, pre-abort and abort during the open/read sequence. |
| 25 | The 400-entry cap is removed. | A 450-model catalog is returned intact; inspected host/protocol catalog path has no matching 400-entry restriction. |
| 26 | RPC errors preserve setup access and show Retry. | Gear visibility after failure, popup error/retry recovery and generation guards for stale status responses. |

## Decisions that differ from the proposed review snippets

### History rollback is progress-aware

Rolling back every 4xx to the beginning of its turn would remove tool results
for actions that actually ran. The bridge instead tracks whether usable model
content or calls have been committed. A failure before that progress removes
the new input from future API requests and explains the exclusion. A later
failure preserves prior rounds and pairs every tool call with a response.

Context trimming adjusts the current history marker as old completed turns are
removed. A later failure therefore cannot use an obsolete array index to remove
the wrong messages. Oversized current input is rejected without first deleting
otherwise useful old history. Turn settlement records completed-turn boundaries
once, through the existing single terminal path.

### Tool identity is not guessed

An explicit index identifies a streamed call. A stable id can identify a call
when index is absent, including mixed indexed/id-only continuations. Conflicting
identities fail the stream. If multiple calls exist and a continuation supplies
neither index nor id, the bridge cannot safely infer its destination; the client
rejects it before any final tool calls are dispatched.

### Planning is enforced locally

No NanoGPT-specific plan API field was invented. A plan turn receives an explicit
system instruction and no definitions. The dispatcher independently blocks
unexpected returned tool calls. On an ordinary subsequent turn the system text
is rebuilt and the registered tool definitions are available again.

### Reasoning default is an honest compatibility fallback

SDK capabilities require a non-empty coarse reasoning ladder. Rather than expose
three controls that do nothing, the provider declares one fallback identifier,
`medium`, labelled **Provider default** in its descriptors and model metadata.
That identifier does not cause a medium-effort request. The API body contains no
effort override, so each upstream backend uses its own default.

Actual model-specific effort support remains a future compatibility feature.
It would require a verified NanoGPT request contract and reliable supported-model
metadata, not an unconditional parameter applied to the entire catalog.

### Authentication health belongs to the current server contribution

The installed maintenance schema has no current envVars field. Inspection of
bb's request adapter confirms that health requests carry provider identity,
cwd and static options, rather than per-turn credentials. Reading process.env
would therefore allow a stale key snapshot to report incorrect readiness.

The bridge returns a baseline requiring setup. The inspected server health flow
overlays an unauthenticated/expired baseline with a ready result when the plugin's
current credential-health contribution is available. Keeping maintenance health
enabled is necessary for this path; simply disabling it or returning unsupported
would bypass that overlay in the inspected implementation.

Tests exercise the baseline and the current contribution separately. A new
end-to-end live-bb health check has not been run, so this report does not claim
that every installed bb version has been exercised with the change.

## ADDITIONAL_BUGS.md findings

### A1 — Attachment failure reasons

Confirmed as a usability issue. Missing files, permission failures, directories
or other non-regular files, exhausted file descriptors and filesystem I/O errors
now have different descriptions. Unknown failures still use a safe generic
fallback. The generated description uses a display filename rather than the raw
error message/full path. Cancellation is propagated as cancellation, not shown
to the model as an unreadable-file failure.

Regression tests directly exercise missing-file and directory descriptions,
plus cancellation and normal text handling. Permission/resource/I/O categories
are mapped from standard Node filesystem error codes; real ACL or disk-failure
conditions were not created on the user's machine.

### A2 — Popup draft after Close

The report assumes a retained component; a real host lifecycle leak was not
reproduced. Normal React unmounting already discards component state. Nevertheless,
explicit Close now clears the unsaved API key, base URL edit and transient
message before asking the composer to close the popup. This makes the behavior
safe even if a host retains the component. It does not overwrite saved settings.

The regression deliberately keeps the rendered component alive after Close and
checks that the key is blank and the URL reverts to the saved value. Outside
click/Escape dismissal remains host-owned; this component has no SDK visibility
callback for those actions. Such dismissals rely on the host's mount lifecycle.

### A3 — Ignored late/unmatched tool replies

Ignoring an unknown reply is correct after cancellation/replacement; accepting
it would revive stale work. The improvement is diagnostic visibility, not a
change in how responses are applied. `NANOGPT_DEBUG_BRIDGE=1` in the bridge
process environment enables a generic stderr message. Default mode stays silent.

The diagnostic includes no response id, payload, arguments or credentials.
Console debug/log was intentionally avoided because Node sends those to stdout,
which is reserved for the bridge's JSON-RPC stream. The regression verifies both
the opt-in switch and absence of supplied secret response data in the message.

### A4 — Model ID validation

Confirmed. Model IDs are trimmed and checked at the options/client boundary.
Empty/whitespace-only values, values longer than 512 characters and values with
control characters fail before fetch. The client also validates catalog IDs.
Invalid selected IDs produce a clear failed-turn message rather than the outer
generic unexpected-error fallback.

This is syntax validation, not a static model allowlist. NanoGPT and custom
endpoints can introduce new IDs or account-specific availability. Syntactically
valid but unavailable IDs remain upstream errors, with their message surfaced
through the normal API error path.

## Credential-cache hardening outside the 26 numbered items

Concurrent checks share an in-flight promise keyed by a digest of normalized
endpoint and key. Valid/invalid verdicts live for 60 seconds; unknown results for
5 seconds. Cached/accepted identities are bounded to 64. The maps/sets do not
use raw API keys as identifiers; in-flight requests necessarily hold credentials
while performing their authorized request.

Settings changes clear verdicts and accepted trust. A successful save reseeds
only the just-verified key after persistence. Generation guards prevent an old
check from restoring cleared trust or contributing a removed key to a host.
Tests cover concurrent equivalent endpoints, eviction, trust clearing and key
removal while a response is still pending.

## Important operating limits

| Policy | Current behavior |
|---|---|
| Context | 32,768-token local fallback calculation, with a 4,096 reserve and 28,672 estimated input allowance. Not a verified window for every routed model. |
| Output reserve | Arithmetic headroom for input budgeting; it does not send an upstream output-token limit. |
| Text estimate | UTF-8 bytes / 3 rounded up, plus per-message overhead. Not a model tokenizer. |
| Images in estimates | Fixed 2,048-token allowance per image. Resolution/model-dependent cost may differ. |
| Stored output | At most 24,000 UTF-8 bytes per stored assistant/tool text, preserving head/tail with a marker. Visible output stays intact. |
| Text attachment | At most 100,000 bytes; incomplete trailing UTF-8 is omitted on truncation. |
| Local/embedded images | PNG/JPEG/GIF/WebP; 5,000,000 bytes per image, 10,000,000 combined per prompt. Remote URLs are not downloaded locally. |
| Model list | 10-second operation deadline across headers/body. No 400-entry cap. |
| Completion | 120 seconds for headers or an idle read; consumer pauses/tool waits are outside that timer. |
| Credentials | HTTPS or HTTP loopback only; URL credentials/query/fragment and authenticated redirects are rejected. |
| Persistence | History remains in memory. Stop preserves it; release/replacement/restart does not. Trimming is not persistence. |

A smaller-context or text-only model may still reject a request. Its API error
is surfaced, and failed input before usable progress is excluded from later
requests. The local fallback policy reduces growth; it does not replace verified
model context/vision metadata.

## Verification status

- Baseline: 80 tests across 8 files passed; typecheck passed.
- Current implementation: 162 tests across 10 files pass; typecheck passes.
- Tests use scripted transports, temporary local attachments, the SDK fake
  plugin host, the SDK bridge event collector and DOM rendering. They do not
  call a paid model endpoint or require a real API key.
- Plugin build: passed using `C:/Users/Alex/.bb/bin/bb.cmd plugin build .`;
  server, app and host bundles and metadata were generated successfully. The
  full path was used because bb is not on this shell's PATH.
- `git diff --check`: passed for the current tracked changes.
- Release packaging checks for 0.1.4 repeated all 162 tests, typecheck, bundle
  build and `bb plugin types --check`; the SDK pin and installed host declarations
  both report version 0.6.133.
- Marketplace preparation: its build validates both documents with 562 entries;
  41 relevant marketplace/changed-assets tests pass. The entry targets `^0.1.4`,
  and the overview is copied unchanged from the source overview within the
  4,000-character limit. The existing submission is PR #891 on get-bb/marketplace.
- No new live bb/API smoke run or installation has been performed. Existing
  README live checks are historical. The user subsequently authorized publishing
  the validated source and updating PR #891; release/PR state is verified through
  the remote references rather than inferred from this source document.

## Remaining follow-ups and marketplace handoff

Retry/backoff for transient HTTP statuses and extracting bridge state into a
factory remain separate follow-ups. There are currently no automatic retries,
so no streamed output or tool execution is silently replayed. Automatic
summarization, manual compaction, durable session restore and model-specific
reasoning/context metadata are not implemented or advertised as supported.

Recommended follow-up live checks cover normal and tool turns, Stop then
continue on the same thread, plan mode, key add/remove, the full model picker,
reasoning, context notices and a supported local image. These checks should use
controlled inputs and keep credentials out of recorded output. Version 0.1.4 is
prepared from the passing test/typecheck/build results; new live smoke checks
remain explicitly outstanding rather than being presented as release evidence.

Then update the marketplace entry to reference that release and synchronize its
overview with the source overview. Keep the daemon-restart limitation: context
trimming does not make history persistent. Describe whole-turn eviction, default
reasoning, strict planning and image/endpoint limits as separate behaviors.
