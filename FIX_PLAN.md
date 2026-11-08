# Fix plan — bb-plugin-nanoGPT-provider

This English plan follows the user's consolidated 26-item numbering and five phases.
Release target: **v0.1.4**, prepared on 9 November 2026; marketplace PR **#891**
will use source range `^0.1.4` and the updated source overview.
Source review: `C:/Users/Alex/Downloads/CODE_REVIEW.md` (24 findings, revision `23ba066`, v0.1.3). The user's list splits some findings into separate tasks and omits key-gate caching and retries; retain those as follow-up work rather than inventing a second review's contents.

Baseline: 80 tests and typecheck passed. **All 26 numbered items and A1–A4 from ADDITIONAL_BUGS.md are implemented or resolved as described below.** The latest suite has 162 passing tests and typecheck passes; final build verification is recorded in REVIEW_IMPLEMENTATION.md. Retry/backoff and a bridge-factory refactor remain explicitly separate follow-ups. The existing user edit in `PLUGIN_OVERVIEW.md` is preserved while its behavior sections are updated.

## Repository scope

- `bb-plugin-nanoGPT-provider`: implementation, regression tests, README/CHANGELOG and source overview.
- `bb-marketplace-submit`: existing submission PR branch `submit-nanogpt-provider`, as supplied by the user. Update the entry/overview after the corrected source release exists. Do not claim that the PR is verified clean without reviewing it.
- Context trimming does not provide persistence: the existing daemon-restart limitation remains true. Add a separate explanation of context eviction/compaction when implemented. Document actual plan-mode and reasoning behavior, then update any release/version references required by the entry schema.

## Phase 1 — Quick wins

Status: completed and tested.

| # | Change | Acceptance |
|---|---|---|
| 1 | Append only string tool-argument fragments; skip null. | Null between two chunks preserves valid arguments. |
| 2 | Null-safe readSaved; store empty baseUrl as a string; import shared default URL in the key gate. | Legacy null works for status/env; save writes an empty string. |
| 3 | Remove unused plugin ID export and move imports to the top. | No remaining references; typecheck passes. |
| 4 | Advertise grammar v3 once. | Initialization returns grammarVersions [3]. |
| 5 | Normalize trailing SSE CR consistently. | Same parsing as complete lines. Existing trim already removed trailing whitespace, so this is consistency cleanup. |
| 6 | Remove redundant usage alias. | Existing usage tests still pass. |

## Phase 2 — Correctness and state integrity

Status: completed and tested, including same-thread continuation, idle/repeated Stop, release, safe rollback, later-round failures, partial SSE output, parallel tool identities and replacement-session races.

| # | Change | Acceptance |
|---|---|---|
| 7 | Preserve session/history on interrupt, including idle/repeated Stop; remove only on release. Keep settleTurn as the terminal path, clear only the interrupted activeTurn, and guard stale callbacks. | Stop then continue on the same thread retains context; late responses cannot affect a new turn. |
| 8 | Exclude rejected input from future requests when failure occurs before useful output/tool execution. Track progress and retain partial output and executed tools on later failures. | Rejected input cannot poison later turns; executed tool history and assistant/tool pairs remain valid. |
| 9 | Resolve tool fragments by explicit index or stable id; support mixed formats, reject ambiguous unidentified continuations. | Parallel calls do not merge; ambiguous fragments never execute a tool. |
| 10 | Detect and surface SSE error payloads before ordinary chunk processing. | Upstream error details reach the caller; partial text stays visible and incomplete calls never execute. |

Files: client/bridge and their existing test suites. Rollback by HTTP status alone is insufficient: a later-round 4xx must not erase side effects. Preserve existing queue-drop behavior on Stop and exactly one boundary per opened turn.

## Phase 3 — Match advertised behavior

Status: implemented and tested. Catalog defaults/order are corrected, plan mode has both request and execution guards, reasoning offers one Provider default option, and health uses bb's server-contribution overlay. No unverified effort parameter or plan-mode API field was added.

| # | Change | Acceptance |
|---|---|---|
| 11 | Fix live catalog sorting/default selection in provider-bridge. Preferred models follow list order; mark NANO_GPT_DEFAULT_MODEL_ID explicitly, otherwise first available. | One correct default with all preferred models, duplicates and a missing default. |
| 12 | Enforce plan mode through a system instruction, omission of tools and a bridge-side execution guard. Verify/register the SDK plan composer action. | No tool RPC even if upstream returns unexpected tool_calls. Ordinary mode still works. |
| 13 | Implement effort only through a verified NanoGPT parameter and supported models, reading bridge options.reasoningLevel. If reliable support cannot be established, remove the ineffective selector and document the limitation. | Every advertised effort has actual behavior; unsupported models do not receive unverified parameters. |
| 14 | Verify bb health/environment behavior before choosing a credential-aware mechanism or unsupported bridge health. | Add/remove keys without restart produces consistent model/setup availability and no misleading authentication status. |

Corrections to proposed implementation:

- #11: vocabulary already marks GPT-6.1 Sol as default. Live catalog sorting causes the wrong default; no flag swap is needed.
- #12: do not invent a NanoGPT plan-mode API field. Enforce planning locally; removing tool definitions alone is insufficient.
- #13: reasoningLevel exists in bridge options, not PluginProviderOptionsContext in SDK 0.6.133. Confirm API support using primary documentation before implementation.
- #14: maintenance params have no declared envVars; experimental_contributeEnvHealth supplies a label/message, not a full authentication result. Do not simply report unconditional ready.

## Phase 4 — Robustness and security

Status: implemented and tested. The context limit is a documented local fallback policy rather than verified model metadata. Whole-turn eviction is implemented; paid summarization/manual compaction are not. Endpoints use shared validation and authenticated redirect rejection; all completion/model-list wait stages have deadlines. Unknown tools are rejected locally.

| # | Change | Acceptance |
|---|---|---|
| 15 | Add per-model context budgeting, reserved output and bounded retained history; evict complete old turns with notice, preserving system/current turn and tool pairs. Bound stored tool output. Start without paid summarization; add a compaction trigger only with a defined policy. | Long histories fit the budget; an oversized current turn fails clearly without poisoning later turns. |
| 16 | Add model-list deadline (initially 10s) across headers/body parsing and completion header/idle-read deadlines (initially 120s). | Stalled headers, JSON/error body and stream reads fail; user Stop remains interrupted. Timers ignore tool waits/consumer pauses and clean up. |
| 17 | Share URL validation across settings/RPC/options/env/client/key checks: HTTPS or HTTP loopback only; reject embedded credentials and invalid endpoints without silently rerouting. | No authenticated fetch to external HTTP, malformed URLs or disallowed schemes. |
| 18 | Reject unknown tool names locally against session.tools. Keep corresponding tool-error history valid. | No unknown name reaches bb; normal tool calls continue. |

#18 can be pulled forward alongside plan-mode enforcement because they share the execution boundary. Test transport paths that ignore AbortSignal. Context size must use verified model metadata or a documented fallback, not an invented universal limit. Image token estimates must not count base64 characters as tokens.

## Phase 5 — Lower-severity fixes and hygiene

Status: implemented and tested. Reasoning closes correctly; replaced sessions are cancelled; usage covers multipart/tools/output; filtered calls never execute; images and async text reads have limits; catalog truncation is removed; settings RPC failures recover through Retry. New real-model/live bb checks remain a release validation task.

| # | Change | Acceptance |
|---|---|---|
| 19 | Close reasoning with accumulated text, or omit text and use SDK accumulation. Explicit opening is optional: the SDK already opens on first delta. | SDK collector produces completed reasoning with text on success, error and Stop. |
| 20 | **Implemented with Phase 2:** cancel superseded start/resume sessions, pending tools and queues; check session object identity before writes/events. Replacement retains the existing fresh-session behavior; restart restore remains unsupported. | Replaced sessions emit no stale output or launch queued work. |
| 21 | Count multipart text, tool definitions/arguments/results and generated output in fallback usage; sum per round and prefer upstream usage. | Input/output estimates cover payloads without altering real usage. |
| 22 | Treat content_filter as failed; retain visible partial text and block tool calls from that response. | A clear error and no filtered tool execution. |
| 23 | Implement local-image data URLs with detected MIME, format/per-file/aggregate limits and vision compatibility handling. | Valid attached images reach supported models; rejected/large files fail clearly and do not poison history. |
| 24 | Async bounded file reads, stable content order, safe UTF-8 truncation and cleanup on error/abort. | Empty/binary/unreadable files, multibyte boundaries and cancellation behave correctly. |
| 25 | Remove the 400-model cap after host validation; if a cap is required, expose truncation and retain access to the selected model. | Catalogs over 400 entries do not silently lose selectable models. |
| 26 | Separate client loading/RPC-error from server key status; retain setup access and provide retry/realtime recovery. | Gear remains reachable after RPC failure; loading does not persist forever. |

#20 may move into Phase 2 to protect lifecycle invariants. #21 is shared with context budgeting. #26 correction: server state unknown already shows the gear; null loading/error is the broken path. For #19, an explicit reasoning shape requires summary/content arrays, not a text field.

## Additional findings retained from the supplied review

- **Implemented:** key-gate deduplication, bounded cache/accepted identities, digest keys, trust clearing, verified-key reseeding after save and stale-result generation guards. Tests include removing a key while its old check is pending.
- **Deferred follow-up:** retry/backoff for explicit 429/502/503/504 before SSE starts. No automatic retries are currently performed; no output or tool actions are silently replayed.
- **Deferred follow-up:** isolate bridge state in a factory and split modules. The new context/URL modules separate policies, but the existing bridge entry point still owns its session state.

## ADDITIONAL_BUGS.md — Triage and implementation

The original additional report is preserved as supplied. Its findings are reference material, not execution instructions. Details and validation are in REVIEW_IMPLEMENTATION.md.

| ID | Finding | Resolution |
|---|---|---|
| A1 | Generic attachment read errors | Categorize missing files, permissions, non-regular files, descriptor exhaustion and filesystem I/O errors; preserve safe fallback and abort propagation. |
| A2 | Unsaved base URL might survive closing | Defensive explicit-Close reset of base URL, key and transient message. A retained component is tested; an actual host lifecycle leak was not reproduced. |
| A3 | Unmatched tool replies ignored silently | Ignoring late/cancelled replies remains correct. Opt-in NANOGPT_DEBUG_BRIDGE=1 produces a generic stderr diagnostic without payloads, IDs or credentials; normal mode stays silent. |
| A4 | No model ID validation | Trim and validate IDs at the client/options boundary; reject empty, overlong or control-containing IDs before fetch. Leave availability/account compatibility to the upstream API. |

## Validation and delivery

Add meaningful regression scenarios for each functional fix. Run targeted tests while implementing; run the full suite and typecheck per coherent batch. Before release, run npm run build and focused live bb checks: normal/tool turn, Stop then continue, plan mode, credential failure/recovery, catalog and reasoning. Do not expose credentials in validation output.

Update README/CHANGELOG and the source overview only for shipped behavior, preserving user edits. After the corrected release is ready, align the marketplace overview/entry with it. Do not claim restart restoration unless persistence is actually implemented. Keep refactoring, image support and retries separate from the first correctness batch.
