# bb Conversation History API Audit

- **Audit date:** 2026-11-09.
- **Scope:** Public history-API contract/source audit, with follow-up notes for the implemented adapter and transport.
- **Installed SDK:** `@get-bb/plugin-sdk` 0.6.133.
- **Matching local bb source:** `C:\Projects\bb\src`, declaring SDK 0.6.133 and `bb-app` 0.49.0.

## Decision

Permission follow-up: the bridge now explicitly rejects model calls to the hidden
history tool, enforces session denials on internal retrieval, and rejects duplicate
tool identities. A missing or denied retrieval tool fails resume before generation.
The initial permission audit overstated baseline dispatch isolation: hiding the
tool definition alone did not prevent a returned model call. That dispatch guard
is now implemented and regression-tested; see
[the permission guide](PERMISSIONS_AND_TOOLS.md).

bb exposes its saved thread event stream to plugin server code through `bb.sdk.threads.events.list()`. This is the preferred source for restoring NanoGPT conversation context. A duplicate SQLite transcript is not justified by the API findings.

History does **not** arrive automatically in `thread/resume`. The bridge needs an explicit retrieval step. The existing native plugin-tool channel is a viable transport candidate: a registered read-only server tool can read the current thread's events and return a versioned JSON page to the bridge during its first active turn.

The saved stream is sufficient to design restoration of ordinary text conversations and normalized NanoGPT tool interactions. It is **not an exact archive of previous NanoGPT API requests**. Output retention, attachment references, normalized IDs, and missing model-round grouping impose real limits. Full restoration parity for every historical attachment or malformed/interrupted tool call has not been established.

**Implementation recommendation:** use the bounded event-history adapter and bridge-controlled read-only retrieval tool described below. Their code is now implemented. Validate the path end to end before treating restoration as production verified.

## Evidence and Verification Boundary

This audit used three kinds of evidence:

1. Runtime introspection and schema probes against the SDK installed in this plugin.
2. Source inspection of bb's SDK, runtime adapter, server routes, event schemas, persistence hydration, and plugin-tool routing.
3. Inspection of existing upstream test fixtures for event pagination and retained-output expiry. Those tests were read, not executed during this audit.

The installed and local-source declaration bundles have identical SHA-256 hashes:

| Declaration bundle | SHA-256 |
| --- | --- |
| `bb-plugin-sdk.d.ts` | `B9C9679DAF6714AA9E1F356E0510C58E5AB2962B023092DB826927089C6C5670` |
| `bb-plugin-sdk-provider-bridge.d.ts` | `BC8802B2BC88CCC8A596791098272E7F0DFF0E79793F3CE7F28536F98D64AA8C` |
| `bb-plugin-sdk-host.d.ts` | `9D631024AAB0378A2DD14D22496FEA3D77E46DB6EA0724FD51CAC4AC80DAA053` |

These matches establish the public type-contract correspondence. They do not prove that a deployed bb binary was built from this exact checkout. An exact checkout commit was not established.

`bb` was unavailable on this shell's PATH, no process matching `*bb*` was found, and a TCP check of `127.0.0.1:38886` returned false. These checks do not rule out a differently configured or remote server. No live user's transcript was fetched, no daemon was restarted, and no live transport or attachment restoration was tested.

The repository upstream is [get-bb/bb](https://github.com/get-bb/bb). Source paths below are relative to the inspected local checkout, not claims about a future upstream release.

## 1. What the Bridge Receives

Runtime inspection of the installed schemas produced these top-level fields:

| Request | Declared fields | Historical conversation supplied? |
| --- | --- | --- |
| `thread/start` | `threadId`, `cwd`, `options`, `dynamicTools`, `disallowedTools`, `instructionMode`, optional `input` | No history field; `input` is prompt input, not role-tagged conversation messages. |
| `thread/resume` | `threadId`, `cwd`, `options`, `dynamicTools`, `disallowedTools`, `instructionMode`, `providerThreadId` | No declared transcript or history snapshot. |
| `turn/start` | `threadId`, `providerThreadId`, `input`, `clientRequestId`, `options` | The submitted prompt input, not the accumulated assistant/tool history. |

The schemas are loose, so absence from the declared fields is not proof that all extensions would be rejected. The stronger evidence is `packages/agent-runtime/src/bridge-protocol-adapter.ts`: its `thread/resume` translation constructs identity, working directory, and session options/tool configuration, without fetching or adding historical events.

`contextSnapshotSchema` is also not a transcript. It describes token usage, context categories, window size, model, and session identifiers.

The protocol uses `providerThreadId` as a durable provider-session handle. bb persists the handle and supplies it to a new bridge. Persisting that identifier does not itself persist the provider's message array.

### Current plugin behavior

`src/provider-bridge.ts` creates `messages: []` in `openSession()`. Both start and
resume use that function. Resume sets `restorationRequired: true`; its first
active turn loads saved events before adding the current prompt or calling
NanoGPT. The current bridge advertises `sessionRestore: true` and returns
`sessionRestorable: true` for start/resume. Those flags describe the implemented
path; a real daemon-restart check remains outstanding.

`sessionRestorable` refines the handshake's restoration capability and affects runtime lifecycle decisions, including whether an idle session may be released. It must not be enabled merely because a history endpoint exists.

## 2. Supported Source: Thread Events

The plugin server receives `BbPluginApi`, whose `sdk` includes:

```typescript
type HistoryReadArgs = {
  threadId: string;
  afterSeq?: string,
  beforeSeq?: string,
  limit?: string,
  order?: "asc" | "desc",
  types?: readonly [ThreadEventType, ...ThreadEventType[]],
  signal?: AbortSignal,
};
```

`events.list(args)` accepts these fields and returns `Promise<ThreadEventRow[]>`. For example:

```typescript
const events = await bb.sdk.threads.events.list({
  threadId,
  order: "asc",
  limit: "100",
  signal,
});
```

The corresponding endpoint is:

```text
GET /api/v1/threads/:id/events
```

The SDK serializes the query through its existing transport. Plugin code should use `bb.sdk` rather than acquiring or copying server authentication credentials.

Important access facts:

- `bb.sdk` is available after the server is listening. Use it inside a tool handler, service, or timer; accessing it during initial factory execution can throw.
- The plugin-bound SDK retains `threads.events`. Its metadata wrappers do not remove history access.
- The route requires an existing public thread. Deleted threads or threads in deleted projects return not found.
- The inspected API does not declare an additional history-read manifest permission. Existing server authentication and access rules still apply; this is not an unauthenticated public endpoint.
- A retrieval tool should take its thread identity from trusted `PluginAgentToolContext.threadId`, not accept an arbitrary target thread ID from tool arguments.

### Row structure

Each returned row has:

```typescript
{
  id: string;
  threadId: string;
  seq: number;
  createdAt: number;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  type: ThreadEventType;
  data: /* event-specific payload */;
}
```

The typed union pairs `type` with the appropriate `data`. Row IDs and sequence numbers support ordering and deduplication; turn scopes support reconstruction of completed-turn boundaries. Provider identifiers may appear inside event-specific data.

### Pagination and response limits

Verified in the server contract, route, and database query:

- The default and maximum page size is **100 events**. Numeric query values are strings in the SDK arguments.
- Default order is ascending; specify it explicitly in restoration code.
- `afterSeq` and `beforeSeq` are exclusive bounds (`>` and `<`).
- The result is a bare array, without `hasMore` or a snapshot token.
- Missing sequence numbers do not by themselves indicate corruption: filtering and event pruning can leave gaps.
- Hydrated event data has an **8 MiB response limit**. A response that would exceed it fails with HTTP 413 and `event_data_too_large`.
- Reducing the page size can resolve a large-page failure. An individual event above the limit cannot be recovered simply by requesting a page of one; fail explicitly or define a supported degraded-content policy.

An append-bounded scan can capture the latest sequence with `order: "desc", limit: "1"`, then read ascending pages with `beforeSeq: String(throughSeq + 1)`, advancing `afterSeq` to the last returned sequence. This prevents new appends from extending the scan indefinitely. It is **not a transactionally consistent snapshot** when history is rewritten during pagination.

## 3. Completeness Assessment

| Data | Source | Assessment and restoration rule |
| --- | --- | --- |
| User text | `client/turn/requested.data.input`; normalized `userMessage` items where present | Available. Correlate request IDs, acceptance, and rejection; do not append both representations. |
| Request provenance | Request ID, retry marker, initiator, sender, target, execution options | Available for modern requests. Needed to distinguish accepted input, retries, and rejected or queued attempts. |
| Assistant text | `item/completed` with `item.type === "agentMessage"` | Available as normalized text. Prefer the completed item over its preceding streaming deltas. |
| Partial assistant text | Started items and text deltas; settlement events where emitted | Requires interrupted-turn handling. A hard crash may leave an incomplete item without a final completion. |
| Tool name and arguments | Normalized `toolCall` item fields `tool`, optional `arguments` | Usually available for this plugin's valid tool calls. Arguments have already been parsed and normalized. |
| Tool output or error | `toolCall.result`, `error`, `status`, optional `truncation` | Available subject to output retention and optional-field semantics. Missing output is not proof of successful empty output. |
| Tool identity | bb-generated item ID and turn scope | Available for pairing normalized items. Original model call IDs and exact model-round grouping are not preserved by this schema. |
| Turn boundaries | `turn/started`, `turn/completed`, turn scopes | Available, including completed, failed, and interrupted statuses. Abrupt termination still needs explicit policy. |
| Attachments | Rich request `PromptInput` and simplified user-content references | References are stored; historical bytes and same-host accessibility are not guaranteed. |
| Context clear | Completed `system/operation` with `operation: "context_clear"`; provider clear events | Available. Exclude earlier context even though it remains visible in bb. |
| Compaction | `thread/compacted` and `contextCompaction` items | Markers exist, but they do not carry a provider's complete compacted message state or summary. |
| Current system instructions | Session construction/options | Rebuild through the normal current-session path. Do not promote historical user text into system instructions. |
| Exact prior NanoGPT request | No public archive of `NanoGptMessage[]` identified | Not available through the inspected event contract. Semantic reconstruction is the appropriate target. |

### Tool-output retention

The inspected bb implementation applies these rules to selected completed-item string outputs:

- Above **32 Ki characters**, the full string is retained separately for **7 days** from the event's creation.
- The persisted event also contains a preview retaining approximately **2 Ki characters at each end**, with truncation metadata.
- The events API hydrates the full value while the retained copy remains valid and the response fits its size limit.
- After expiry, the preview and truncation metadata remain. The missing middle cannot be recovered from that API.

The targets include `toolCall.result`, command output, and selected web/image output fields. These rules do not mean every event expires after seven days or that all structured results follow the same string rule.

The plugin separately bounds model-history assistant/tool text to 24,000 bytes. Reapplying that bound does not eliminate the need to recognize bb's retention truncation: a head-and-tail preview differs from the original prefix that the model previously received.

### IDs, grouping, and malformed arguments

The plugin emits a bridge item ID derived from its own turn/round identifiers and the original model tool-call ID. bb's assembler translates provider item keys into bb-owned item IDs. The normalized public tool item does not expose a stable original `tool_call_id` or the original assistant message's full `tool_calls` array.

A valid restored request can generate deterministic replacement call IDs from the thread and bb item identity and use the same generated value in both the assistant call and its tool result. This restores a valid relationship, not the exact original request. Original multi-call model-round grouping needs an explicit reconstruction policy.

For malformed tool arguments, the current plugin emits `{}` to the display item together with an error; it does not persist the original malformed argument string there. That string cannot be reconstructed faithfully. Preserve the failure as historical context rather than treating the displayed `{}` as evidence of a successfully executed call.

Historical tools must never execute during replay.

### Execution order and input retention

Submission order is not model execution order. In this bridge, `turn/steer` acknowledges a queued prompt inside the active turn, then executes it in a later turn. Restoration therefore groups items by turn and installs that turn's executed prompt before its assistant/tool messages. It never inserts a submitted follow-up between tool calls and their results.

New terminal boundaries carry a provider-owned `providerCheckpointId` beginning with `nanogpt-context-v1:`. Its base64url JSON payload contains only `{ requestId: string | null, inputRetained: boolean }`. The bridge sets the request ID when execution begins and computes retention from the final in-memory context after rollback and tool settlement. bb stores this value in `turn/completed`; the existing event retrieval path already returns it. This records execution identity and disposition without duplicating prompt or response content. A malformed checkpoint with this prefix fails restoration explicitly.

Checkpoints resolve several cases that acceptance alone cannot distinguish: a steer accepted but canceled before execution, a queued prompt executed in a different turn, and accepted input later rolled back after an API or local-budget failure. Retry markers are provenance rather than a reason to discard input: an accepted retry can contain the original question after an initial rejection, or a continuation prompt after a partial answer. Restore the actual executed input once per request ID.

For older events without checkpoints, the adapter uses the first turn acceptance as that turn's input, carries additional queued acceptances forward to later turns, and clears that pending queue on interruption. Failed turns with no model progress or the bridge's explicit input-discard error suffix are omitted. These rules are compatibility inferences: logs without a completed boundary, or histories produced by other providers, may lack enough information to determine exact execution and retention. URL/local-attachment limitations remain unchanged.

All terminal statuses create an eviction boundary when reconstructed messages remain. A failed or interrupted turn containing partial output or tool results is a complete historical unit for context budgeting; it must be removable together with its prompt and tool-call/result pairs.

### Attachment limits

Modern `PromptInput` can include image URLs, local image/file paths, host/project references, and file metadata. Normalized display user content has fewer fields. Prefer the original accepted request payload when it is available.

A path or URL is not an immutable content snapshot. A local file may have changed, moved, been deleted, or belonged to another host; a URL may have expired. The existing plugin reads host-staged local content and does not establish a general historical-restaging API.

Before claiming attachment parity, verify a supported way to retrieve and restage those historical references. Until then, scope initial restoration to supported references and report unavailable content explicitly; do not silently read a same-named file on the wrong host.

## 4. Other APIs Considered

| Surface | Why it is not the primary reconstruction source |
| --- | --- |
| `threads.output()` | Returns the latest final output, not the whole conversation. |
| `threads.promptHistory()` | Provides prompt history, not the full assistant/tool exchange. |
| `threads.timeline()` | A UI projection with pagination, collapsed/deferred content, and summary/detail behavior. Useful for consistency information and display, but not a direct model-message archive. |
| `threads.message()` | Message-oriented lookup with surrounding context; not a complete replacement for ordered event retrieval. |
| `threads.context()` / context snapshots | Context usage information, not the conversation body. |
| Thread storage APIs | File listings and locations; these do not provide a ready-made `NanoGptMessage[]` transcript. |
| `deriveProviderOptions()` | Synchronous callback. Cannot await a fresh paginated SDK history read. Its options are also persisted with session data, so embedding the entire transcript would create duplication. |
| `agents.contributeInstructions()` | Synchronous, length-limited, and applied at session construction. Flattening history into instructions loses roles and tool semantics. |
| `message.dispatch` hook | A policy checkpoint, not a history payload amendment API; explicit Send-now bypasses it, and it does not cover every context operation. |

The events endpoint lacks repeatable-read pagination. The timeline API exposes an opaque `page.historySnapshot`, but that token is not accepted by `threads.events.list()`. It must not be presented as an event-snapshot guarantee. Integration needs a tested rewrite-detection/retry policy or a stronger bb API if consistency cannot be established with existing supported surfaces.

## 5. Server-to-Bridge Transport

### Process boundaries

`server.ts` receives `BbPluginApi` and can read history. The bridge starts with only `pluginId`, `dataDir`, and `tempDir`; it does not receive `bb.sdk`.

`host.ts` exports both the host RPC entry and the provider bridge, but bb loads them in **separate worker processes**. An imported module-level map in `host.ts` is not shared memory between them.

The host RPC context exposes lifecycle cancellation, paths, watchers, worker retention, and host-to-server signals. Its declared interface does not provide a general `bb.sdk.threads` client. Server-to-host RPC plus a map therefore does not, on its own, deliver history to the bridge. A temporary-file or local-IPC design would need additional implementation and lifecycle work.

### Implemented transport: a read-only native tool

The existing API already provides a bridge-to-server request/response channel:

```text
Bridge, during first active turn
  -> item/tool/call
  -> runtime resolves the current thread and turn
  -> authenticated daemon forwards the request to bb server
  -> registered plugin tool reads bb.sdk.threads.events.list()
  <- versioned JSON page returned as text tool content
  <- bridge decodes the response and reconstructs context
  -> first NanoGPT request
```

Source inspection confirms:

1. `bb.agents.registerTool()` supports asynchronous execution with trusted thread/project context and cancellation.
2. `bb.agents.configure()` can select the registered tool for this provider's next session construction.
3. The bridge already sends `item/tool/call` for dynamic tools.
4. The runtime resolves thread identity and requires a known turn ID or active turn. Fetching from an idle `thread/resume` handler without that context is not the appropriate design.
5. The daemon flushes pending thread events before forwarding a tool call.
6. The server authenticates the daemon session and verifies that the thread's environment belongs to that host before invoking the registered plugin tool.
7. A string tool result becomes an `inputText` content item. The installed bridge decoder recovers that string and the error status; a synthetic JSON round-trip probe passed.

This supports lazy retrieval after the first new turn opens and **before** its input is appended to restored history or any NanoGPT request is sent. The implementation fixes an upper sequence boundary on the first page, limits pages to 25 events and scans to 400 pages, validates each returned row and thread, and keeps the reconstruction temporary until the final page arrives. Cancellation propagates through bb's native-tool request. Automated adapter, server and bridge tests cover representative reconstruction, fixed-boundary server pagination using the SDK fake host, hidden-tool transport response handling, and fail-closed behavior. Real bb server and restart verification remain outstanding.

### Implemented plugin-owned contract

`nanogpt_restore_history` accepts `afterSeq`, `throughSeq`, and `currentRequestId`
(nullable values), and returns the following versioned envelope. This is the
plugin's contract, rather than a new bb SDK method. The server binds thread identity
to tool execution context; callers do not supply an arbitrary thread ID.

```typescript
type HistoryPage = {
  version: 1;
  threadId: string;
  throughSeq: number;
  nextAfterSeq: number | null;
  events: ThreadEventRow[];
};
```

Use a distinctive plugin-owned tool name. Bind the target thread to execution context, validate cursor bounds and request association, and propagate the cancellation signal. Decide byte limits independently of the upstream 100-event maximum; avoid returning an unbounded transcript in one tool result.

Select the tool into the provider's dynamic-tool set, but filter it from the NanoGPT model's advertised tools and ordinary model-driven dispatch. Invoke it only from bridge restoration logic. Its transport payload should not be appended as a conversational tool result, and restoration should not emit replayed historical tool items. This avoids recursive transcript growth and accidental model-triggered bootstrap calls.

The source-confirmed transport uses existing supported registration and request methods. No new SDK method, server authentication secret, persistent duplicate transcript, or internal database access is required for the proposed path.

## 6. Mapping Example

This is a synthetic illustration of verified shapes, not a captured user conversation:

| Stored fact | Reconstructed model context |
| --- | --- |
| Accepted request `creq_23456789ab`, text `Remember the project name: Atlas.` | One user message with that text. |
| Completed `agentMessage`, text `I will use Atlas.` | One assistant message with that text. |
| Completed `toolCall`, item ID `item-example`, tool `docs_search`, arguments `{ "query": "Atlas" }`, result `Found Atlas documentation.` | An assistant tool call with a deterministic generated ID, followed by a tool message using that ID and the saved result. No tool execution. |
| Current request `creq_bcdefghijk`, text `What is the project called?` | Excluded from the historical scan, then appended once from the live turn input. |

Completed-item text must replace, rather than duplicate, its accumulated streaming deltas. Started/completed versions of the same item must be merged by item identity. Reconstructed system instructions come from current session construction, outside this historical mapping.

## 7. Consistency and Failure Rules for Implementation

The adapter and transport must implement these rules:

1. **Current-request exclusion:** locate and exclude the pending request by its ID and validated sequence boundary. Do not append it once from saved requests and again from `turn/start`.
2. **Acceptance and retry semantics:** correlate requests with acceptance/rejection and actual turn scopes. A retry marker is provenance, not permission to discard every repeated request indiscriminately.
3. **Explicit context clears:** honor the latest completed `context_clear` operation and relevant provider clear boundary. Never resurrect intentionally cleared text merely because it is still visible.
4. **Provider/session replacement:** separate historical transcript visibility from the current context lineage. Define handling for provider changes and replacement sessions that lost context.
5. **History rewrites:** message editing can remove an event suffix and dispatch replacement work. Sequence bounds alone do not make a scan consistent across this operation. Detect and restart or reject an inconsistent scan; discard partial reconstruction.
6. **Incomplete work:** handle pending tool items and interrupted text explicitly. Never invent successful results for tools without a stored terminal result.
7. **Retention and size:** preserve truncation markers, adapt page size on 413 where possible, and fail explicitly when required data is unavailable. Apply the existing model budget after reconstruction.
8. **Lifecycle:** serialize restoration with the session queue; ignore late responses after Stop, release, replacement, or plugin disposal.
9. **Atomic publication:** construct context separately and install it only when the whole bounded reconstruction succeeds. Do not leave a half-restored session available for a model request.
10. **Capability accuracy:** verify the advertised restoration behavior against supported bb versions before release. The current implementation sets the flags true; live restart verification remains open and must not be implied by unit tests.

## 8. Checks Performed and Remaining Work

| Check | Result |
| --- | --- |
| Installed SDK version and declaration-bundle comparison | Passed; all three inspected bundles match local SDK 0.6.133. |
| Runtime schema field introspection | Confirmed start/resume/turn fields and absence of a declared resume transcript. |
| Valid start, resume, and turn payload probes | Passed. The turn request ID must use bb's `creq_` format; the corrected probe passed. |
| JSON history-envelope tool-result decoder round trip | Passed against installed SDK runtime. |
| SDK history method, route, cursor ordering, page and byte limits | Verified by source and existing test-fixture inspection. |
| Normalized tool mapping and output expiry | Verified by source; expiry fixtures inspected. |
| Native tool request routing and process separation | Verified by source and public SDK declarations. |
| Live history retrieval from the user's bb instance | Not performed; no reachable local instance established. |
| First-request restoration code path | Implemented across `src/provider-bridge.ts` and `server.ts`; actual transport/restart behavior remains unverified. |
| TypeScript validation | Passed after the Phase 3 implementation. |
| Historical attachment restaging and rewrite-race handling | Open integration requirements; full parity not established. |

The contract/source audit and adapter/transport implementation are complete.
Automated coverage now exercises reconstruction, server pagination and the bridge's
first-request restoration path. On 2026-11-09, the current full repository suite
passed all **215 tests across 12 files**, and type checking passed. These local
checks do not exercise a real daemon restart, historical attachment restaging,
or concurrent history rewrites. The next integration step is to verify the real
native-tool channel and inspect the first outgoing NanoGPT request after restart.

## Source Index

Installed public declarations are under `node_modules/@get-bb/plugin-sdk/bundled-types/`. The following implementation references are under `C:\Projects\bb\src`:

| Source | Relevant finding |
| --- | --- |
| `packages/sdk/src/areas/threads.ts` (`ThreadEventsListArgs`, `ThreadEventsArea`, `createThreadsArea`) | Supported SDK method and HTTP transport. |
| `packages/plugin-sdk/src/backend-contract.ts` (`BbPluginApi`, `PluginAgents`, `PluginProviderOptionsContext`) | Server SDK access, tool registration/configuration, synchronous option callbacks. |
| `packages/plugin-sdk/src/host-contract.ts` | Host RPC capabilities and context. |
| `apps/server/src/services/plugins/plugin-api.ts` (`wrapSdkForPlugin`, `sdk` getter) | History API remains exposed; SDK initialization boundary. |
| `packages/server-contract/src/api/threads.ts` (`threadEventsQuerySchema`) | Query contract and timeline snapshot distinction. |
| `packages/server-contract/src/common.ts` | 100-event page limit. |
| `apps/server/src/routes/threads/data.ts` (`routes.events`) | Thread lookup and query parsing. |
| `apps/server/src/services/threads/thread-data.ts` (`listThreadEventRows`, `hydrateRawThreadEventRows`) | Event decoding, retained-output hydration, 8 MiB error behavior. |
| `packages/db/src/data/events.ts` (`listStoredEventRows`) | Ascending default, exclusive bounds, ordered event records. |
| `packages/domain/src/provider-event.ts`, `thread-events.ts`, `thread-event-scope.ts` | Message/tool shapes, request/retry/acceptance facts, turn scope. |
| `packages/domain/src/shared-types.ts` (`promptInputSchema`) | Rich attachment and prompt-input references. |
| `packages/db/src/retained-event-output.ts`, `data/retained-event-outputs.ts` | Retention constants, preview creation, full-output hydration and expiry. |
| `packages/provider-bridge-protocol/src/assembler/delta-assembler.ts` | bb-owned item IDs and normalized tool-call fields. |
| `packages/provider-bridge-protocol/src/bridge-kit/provider-bridge-entry.ts`, `src/bridge-worker-entry.ts` | Bridge start context and separate process bootstrap. |
| `apps/host-daemon/src/plugin-host-worker.ts` | Separate host RPC worker lifecycle. |
| `packages/agent-runtime/src/bridge-protocol-adapter.ts` | Actual request translation; no transcript replay in resume. |
| `packages/agent-runtime/src/runtime-provider-requests.ts` | Tool-call thread resolution, active-turn requirement, response routing. |
| `apps/host-daemon/src/app.ts` (`onToolCall`) | Event flush before authenticated server forwarding. |
| `apps/server/src/internal/tool-calls.ts` | Authenticated daemon/host validation and native plugin-tool execution. |
| `apps/server/src/services/plugins/plugin-service.ts` (`normalizeAgentToolResult`, `invokeAgentTool`) | Tool result normalization and argument validation. |
| `apps/server/src/services/threads/thread-context-clear.ts` | Context-clear operation preserves visible history. |
| `apps/server/src/services/threads/thread-edit-message.ts` | Suffix deletion and history-rewrite notification. |
| `packages/thread-view/src/build-thread-timeline.ts` | Accepted/rejected request correlation and display projection. |
| `docs/provider-bridge-protocol.md` (Sessions and identifier sections) | Durable handles, restoration flags, session replacement. |
| `apps/server/test/public/public-thread-data.test.ts` | Event filtering, ordering, and oversized page rejection fixtures. |
| `packages/db/test/data/retained-event-outputs.test.ts` | Hydration, expiry, byte-budget, and preview fixtures. |

Plugin-local references: `src/provider-bridge.ts`, `src/context.ts`, `src/attachments.ts`, `server.ts`, `host.ts`, and `contract.ts`.
