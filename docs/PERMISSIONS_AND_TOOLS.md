# Permissions, approvals, and tools audit

Audit date: 2026-11-09. This document describes the working tree released as
package version 0.1.5. Installed SDK: `@get-bb/plugin-sdk` 0.6.133. The initial audit changed no runtime behavior;
follow-up implementation is described next. Baseline findings below are retained
as historical evidence and are not the current support matrix.

## Current implementation and remaining work

Policy propagation, tool denial, settings transport, and opt-in manual approval
are implemented in the current unreleased source. The bridge retains `BridgeExecutionOptions` in frozen per-request
snapshots instead of projecting away the policy. Registration and bridge admission
share the supported-mode definition in `src/permissions.ts`.

| Capability | Current behavior |
| --- | --- |
| Permission modes | Only `full` is advertised and accepted. Valid `accept-edits` and `auto` tuples receive JSON-RPC `-32602` at start, resume, turn start, and steer admission. |
| Policy fields | The complete validated tuple is retained per request and in queued options. These local controls are not sent as NanoGPT completion parameters. |
| Admission order | Unsupported policies are rejected before acknowledgement, queue insertion, session replacement, history retrieval, attachment reads, or generation. SDK-invalid tuples still fail schema validation. |
| Tool denial | Native session denials and per-turn configured denials are combined, omitted from model definitions, and checked before every dispatch. No wildcard expansion is implemented. |
| Tool catalog | Duplicate names, including duplicate history-tool identities, reject construction before an existing session is replaced. A single history definition is expected from bb's trusted plugin registration; the wire name alone cannot authenticate its owner. |
| Internal history tool | Only the bridge's explicit restoration call path can use it. Returned model calls are rejected even when the tool is registered. Denial or absence fails resumed generation before a NanoGPT request. |
| Existing protections | Plan-mode ordinary-tool blocking, unknown-name rejection, malformed-argument rejection, cancellation, and normal full-mode tool continuation remain covered. |
| Manual approval | `confirmToolCalls` opts into a public `tool_use` approval for every eligible ordinary model call in full mode. Only SDK-valid `allow_once` with `grantedPermissions: null` executes. Internal history reads do not prompt. |
| Remaining restriction | No workspace sandbox, generic effect classification, or automatic reviewer is implemented. Restricted modes remain rejected. |

The inspected bb adapter does not forward native `disallowedTools`. The bridge
enforces that field when supplied, and now provides an additional public mechanism:
the plugin's `disallowedTools` string setting is validated and derived into
`options.providerOptions.disallowedTools` on every submitted request. The RPC ->
provider derivation -> bridge path is integration-tested with the public SDK fake
host. No private bb imports or modified upstream checkout are required for this
settings path. A native field supplied by another caller still needs upstream
forwarding. Native denials and catalogs are captured on start/resume; configured
denials and confirmation choices are captured per submitted turn. A configured
empty list never cancels a native session denial.

The execution decision table is deliberately narrow:

| Policy / operation | Decision | Enforcement owner |
| --- | --- | --- |
| Valid unsupported policy | Reject the request before effects. | Plugin admission guard after SDK schema validation. |
| Full / known permitted ordinary tool / confirmation off | Dispatch through bb, subject to individual tool controls. | Plugin name/denial guard, then bb tool implementation. |
| Full / known permitted ordinary tool / confirmation on | Request a one-time manual decision before dispatch. | Plugin approval broker plus bb's public interaction service. |
| Any model call / hidden history tool | Return a failed tool result without dispatch. | Plugin source-aware eligibility guard. |
| Bridge restoration / permitted history tool | Read only active-thread history through the registered server tool. | Plugin guard plus server tool's thread-scoped SDK call. |
| Missing, unknown, or denied tool | Return a failed tool result; internal restoration fails the turn. | Shared definition/dispatch eligibility rule. |
| Provider-native file editing or shell | Unavailable. | No such executor is supplied by this plugin. |

Restricted modes remain disabled because the current public dynamic-tool record
has no trusted effect/path classification, server tools need not run on the thread
host, and a generic automatic review resolver was not established. An approval
dialog alone cannot enforce a workspace boundary. The implemented full-mode
confirmation is a user-selected additional gate, not an implementation of
`approvalReviewer: "automatic"` or a workspace permission grant. No human decision
is relabelled as automatic review.

Verification after the first implementation stage: **13 files / 246 tests passed**, including **31 permission/tool
regression tests**; typecheck passed. The initial `npm run build` could not find
`bb` on PATH; the same plugin build passed using
`C:\Users\Alex\.bb\bin\bb.cmd plugin build .`, producing server, app, and host
artifacts. No plugin install/reload, real reviewer, or live daemon check was run.

The subsequent controls/approval stage adds tests for the normal settings
transport, SDK approval payloads and resolutions, rejection of permission grants,
replayed/malformed/error responses, queued settings isolation, Stop, release,
replacement, internal history, credential redaction, and presentation limits.
Final verification: **13 files / 280 tests passed**, including **59 bridge
permission/control tests** plus the settings RPC and popup checks. Typecheck,
plugin build, and `git diff --check` passed. A deployed bb interaction or daemon
restart has not been exercised.

`node dev_docs/permissions-smoke.mjs` additionally exercises the built host artifact
in a real child process with JSON-RPC over stdio and synthetic completion
transport. All four scenarios passed: allow once dispatched exactly one tool;
deny dispatched none; Stop followed by late allow dispatched none and produced an
interrupted boundary; configured denial dispatched none and raised no approval.
This smoke does not establish live NanoGPT HTTP behavior or installed bb UI
interaction cleanup. It uses only a synthetic key and simulated execution results.

### Manual approval contract and limits

`getToolSettings` and `saveToolSettings` expose only `disallowedTools` and
`confirmToolCalls`. They work independently of key validation and never return
the API key. The composer panel loads them only when expanded; Close discards
unsaved drafts. Invalid values are rejected before persistence or bridge admission.

The default is an empty denylist and confirmations off, preserving ordinary
full-mode behavior. Configuration strings accept at most 16384 characters and
512 unique names; each name is at most 256 ASCII letters/digits/underscores/hyphens.
Commas and whitespace separate names. Validation failures do not become empty
lists. Native session-denial matching retains the SDK's exact-string semantics.

With confirmation enabled, a known eligible model call opens its timeline item
and sends `interaction/request` with `kind: "approval"`, subject `tool_use`, its
actual tool name and item ID, and only `allow_once`/`deny` decisions. The approval
pending map is distinct from pending tool executions. A valid affirmative result
requires `decision: "allow_once"` and `grantedPermissions: null`, as required by
the installed SDK's resolution schema. Session grants, broader permission grants,
missing/malformed results, and JSON-RPC errors never authorize execution.

Each pending request belongs to one session and one turn's abort signal. Stop,
release, and replacement resolve it locally without executing the tool. After a
positive reply, the bridge checks cancellation/session identity again before
dispatch. IDs are unique across approval and tool requests. Late replies and
replayed approvals cannot authorize later calls. A subsequent invocation gets a
fresh approval. The active/queued request's settings snapshot cannot be weakened
by a later submitted turn.

Reviews redact secret-valued fields recursively by key name, including keys,
tokens, passwords, credentials, authorization, and private keys. This is a
best-effort field-name rule, not a general secret detector. The tool's original
arguments remain unchanged for execution. Argument text is enclosed with a fence
longer than any embedded backtick run, so it cannot break the review's code block.
The review labels execution as full-permission work.

An important SDK limit was confirmed: `ThreadEventItemPresentation.detail` is
limited to **280 characters** in 0.6.133. The complete redacted tool/argument
review must fit that schema. The bridge refuses oversized reviews rather than
truncating arguments, hiding part of the operation in another presentation field,
or executing without confirmation. A separate 12000-byte raw review cap bounds
serialization work. Long tool calls can therefore fail with confirmations on.
This is a material usability limit pending a larger public review-detail surface.

Source inspection confirmed that bb's normal thread-stop service interrupts
pending interactions. Automated tests establish local cancellation and zero
dispatch after late replies; they do not establish remote prompt cleanup under
every deployed daemon release/replacement condition. Live verification remains
required before claiming that broader UI lifecycle guarantee.

### External requirements for restricted modes

The remaining work cannot be completed by adding permission strings to NanoGPT
HTTP requests. It requires an execution owner that can enforce workspace scope
for each effect, including server-side tools, plus a documented automatic-review
service or an independently designed reviewer with explicit scope guarantees.
The current dynamic-tool wire record supplies neither a trusted effect/path
contract nor such an executor. Codex's native `auto_review` mapping delegates to
Codex's own agent service; it is not a generic reviewer exported to this plugin.
The plugin continues to reject restricted modes rather than claim those missing
guarantees. Provider-native file/shell tooling remains a separate feature.

The initial isolated audit configuration now selects the production acceptance
tests. The original `dev_docs/permissions-audit.probe.ts` is retained as historical
pre-fix evidence and is no longer selected. Its assertions deliberately describe
behavior that has since been fixed.

## Audit baseline findings and decision

At the audit baseline, implementation was needed for meaningful restricted
permission modes. The plugin advertised only `full`, accepted SDK-valid policies at its
bridge boundary, and then discarded their four policy fields. It had functioning
dynamic tool calling, but did not implement a general approval gate or filesystem
sandbox. Changing the advertised modes alone would overstate its capabilities.

The available Git history does not show a removed implementation: initial commit
`5b9aefb` already declared `permissionModes: ["full"]`, dropped policy fields in
`turnOptionsOf()`, and declared `approvalEnforcedBy: "runtime"`. A history search
over all available refs for these policy names found only that initial commit in
the relevant implementation files. This establishes a longstanding gap in this
repository's available history, not a newly confirmed regression or a conclusion
about unavailable branches or earlier projects.

The implementation plan is stored at `dev_docs/PERMISSIONS_AND_TOOLS_PLAN.md`.
`/dev_docs/` is Git-ignored in this repository, so that plan is a local development
artifact. This tracked audit remains the durable reference.

## Confirmed baseline findings and release impact

The follow-up audit exercised the actual bridge `handleLine()` entry point with
the installed SDK JSON-RPC harness. It used mocked completion streams and tool
results. These are observations of bridge dispatch, not real filesystem effects
or evidence of a deployed bb security bypass.

| ID | Finding | Evidence | Impact and priority |
| --- | --- | --- | --- |
| F1 | Valid restricted policies are accepted but do not control execution. | All five valid policy tuples were exercised through input-on-start and turn-start; every case dispatched the same synthetic tool, with zero approval requests. | Release blocker for adding `accept-edits` or `auto`. Existing normal bb dispatch is limited to the advertised `full` mode. |
| F2 | Session `disallowedTools` is ignored in both exposure and execution. | A full-mode request denying the synthetic tool still advertised it and emitted `item/tool/call`. Resume likewise dispatched explicitly denied history retrieval and then the denied model tool. | Contract-handling defect whenever a caller supplies this field. The inspected bb adapter also needs forwarding support before normal-dispatch enforcement can be claimed. |
| F3 | Queued follow-ups have the same policy loss. | A full-mode turn was held on a tool call; an `accept-edits` / `deny` steer was queued. After the first turn finished, the queued turn dispatched its tool without approval and completed. | The repair must cover steer admission and queued execution, not only session creation or ordinary turn start. |
| F4 | Hiding the history definition did not prevent model dispatch of that registered name. | Follow-up code inspection found no source distinction in `requestToolCall()`; a new regression test now verifies a returned model call is rejected locally. | The initial audit overstated this baseline protection. Source-aware dispatch isolation is now implemented. |
| D1 | A generic runtime automatic reviewer was not established. | Inspected runtime approval handling checks escalation denial, then delegates to `onInteractiveRequest`; tool dispatch uses a separate route. Server interaction registration stores/validates requests and does not establish an automatic reviewer in those paths. | Integration dependency for `auto`. The handshake and API documentation alone cannot justify advertising it. This is an unverified capability, not proof that no other bb component could provide it. |

F1 and F3 share the policy-projection root cause. F2 has a separate root cause:
session construction drops the denylist and both definition generation and
dispatch consult only the tool map. Do not count the four discarded fields as
four independently repaired bugs.

The currently declared full-only behavior is consistent with a provider that
delegates tools without a sandbox. The audit does not recommend enabling modes
merely to make a picker visible. It recommends explicit unsupported-policy
rejection, denylist handling, and then verified restricted execution.

### Additional observations

- A top-level bridge request `tools: []` does not replace `dynamicTools` or
  disable tools. The session schemas permit extra fields, but the implementation
  reads the declared `dynamicTools` catalog. Use the correct layer's contract.
- Duplicate dynamic-tool names silently retain the last definition, because
  `openSession()` constructs a `Map` directly. This is a catalog robustness
  observation; no untrusted tool registration or exploit was demonstrated.
- Missing policy fields and contradictory policy tuples are rejected with
  JSON-RPC `-32602` before model fetches or tool requests. Parsing is working;
  the loss happens after parsing.
- The probes supplied an argument labelled `outside-workspace` to a synthetic
  tool. They verified forwarding only. No path access, process execution, remote
  account, real API key, or actual tool executor was used.

## Audit baseline support matrix

| Field or capability | What works now | Gap |
| --- | --- | --- |
| `permissionMode` | Provider declares `full`; SDK parses `accept-edits`, `auto`, and `full`. bb checks provider-supported modes before dispatch. | Bridge does not retain the parsed mode or reject unsupported valid modes itself. |
| `permissionScope` | SDK validates `workspace` or `full` as part of the policy tuple. | Discarded; no workspace enforcement in dynamic-tool dispatch. |
| `approvalReviewer` | SDK validates `user`, `automatic`, or `null` according to mode. | Discarded; bridge has no approval interaction or automatic review integration. |
| `permissionEscalation` | SDK validates `ask`, `deny`, or `null` according to mode. | Discarded; bridge never raises policy-bearing approval interactions. |
| `dynamicTools` | Definitions received on start/resume are stored, advertised to NanoGPT, and dispatched through bb. | No generic effect classification, workspace metadata, or approval gate. |
| `disallowedTools` | Declared and preserved by SDK start/resume schemas. | Plugin ignores it. The inspected normal runtime adapter does not forward it in session construction either. |
| `tools` | Server contribution selection and NanoGPT request definitions both work. | Neither is an independent runtime permission policy; enabling modes creates no new execution tools. |
| `/plan` | Ordinary model tool definitions are omitted and unexpected returned calls are blocked. | Plan mode is a turn behavior, not a filesystem scope or reviewer selection. |

Normal bb dispatch blocks unsupported modes through its capability check. A direct
bridge request with a valid restricted tuple still parses, however, and receives
no mode-specific enforcement inside this plugin. That distinction matters for
tests, alternate callers, and any future expansion of the advertised modes.

## Contract and ownership

The four permission fields form one discriminated policy, not four independent
configuration switches:

| `permissionMode` | `permissionScope` | `approvalReviewer` | `permissionEscalation` |
| --- | --- | --- | --- |
| `accept-edits` | `workspace` | `user` | `ask` or `deny` |
| `auto` | `workspace` | `automatic` | `ask` or `deny` |
| `full` | `full` | `null` | `null` |

`automatic` is the bb wire value. Do not substitute `auto_review`, which belongs
to another provider's native API. Do not invent combinations such as `full` with
a workspace scope or `auto` with a user reviewer.

bb resolves the policy and sends it in top-level `options` on `thread/start`,
`thread/resume`, `turn/start`, and `turn/steer`. The plugin's
`deriveProviderOptions()` receives the resolved `permissionMode` but does not
receive all four fields. It is unnecessary to duplicate the policy in
`providerOptions`: the bridge wire contract already supplies the complete tuple.
The NanoGPT completion body is a separate contract. These bb policy fields are
local execution controls and should not be added as unverified NanoGPT API
parameters.

SDK runtime probes confirmed that the three example valid tuples in the table
parse and retain their fields. A conflicting tuple (`auto`, `full`, `user`,
`null`) fails. Start/resume schemas also accept `disallowedTools`; turn requests
have no declared per-turn dynamic-tool or denylist field. Schema acceptance
validates structure, not enforcement.

## Audited request path before implementation

1. `server.ts` registers the provider with `permissionModes: ["full"]`.
   `deriveProviderOptions()` returns `model`, `baseUrl`, and `promptMode`.
2. bb's `toBridgeWireOptions()` independently includes all four permission fields.
3. The bridge uses SDK request schemas, which validate the complete policy.
4. `turnOptionsOf()` copies only `model`, `reasoningLevel`, `instructions`,
   `providerOptions`, and `envVars`. All four permission fields are lost here.
5. `openSession()` stores `dynamicTools` in a name-indexed map. Its arguments
   and session type have no `disallowedTools` or permission policy member.
6. `toolDefinitions()` converts the tools to OpenAI-compatible function schemas,
   excluding the internal history tool. The regular completion loop sends them
   to NanoGPT unless the turn is in plan mode.
7. The tool loop rejects malformed arguments and `requestToolCall()` rejects
   unknown names. A known name is forwarded immediately as `item/tool/call`.
8. bb routes the call to its server/plugin implementation and returns a result.
   The bridge stores the result and continues generation, with at most 40 rounds.

This path explains why tools still work while restricted permissions do not.
Existing protections include registered-name checks, JSON-object arguments,
plan-mode blocking, cancellation, and isolation of late results. None substitutes
for authorization of a known tool's effects.

### Why the runtime handshake is insufficient

`initialize` advertises `approvalEnforcedBy: "runtime"`. In the inspected bb
source, runtime approval policy is applied to incoming `interaction/request`
approval payloads, including automatic denial when escalation is `deny`.
`item/tool/call` follows a separate path into `onToolCall()` without that approval
branch. The host daemon forwards it to the server; the inspected server route
checks session/host ownership and dispatches the tool without a general
permission-mode decision. Individual tool implementations can have their own
controls, but this plugin cannot assume that every dynamic tool has them.

The bridge currently sends no `interaction/request` approval at all. The
handshake therefore does not create an approval checkpoint for its tool loop.
An implementation needs an explicit decision before executing effects, with
denial and cancellation handled as terminal outcomes for that call.

bb's provider API documentation describes mode-specific automatic decisions for
approval subjects: `accept-edits` for file changes, `auto` for commands, file
changes and generic tool use, and `full` for all subjects. Those documented
decisions do not classify arbitrary dynamic tools or provide a sandbox. Verify
the actual resolution path and scope guarantees before using them to claim
support for `approvalReviewer: "automatic"`.

The inspected runtime helper `shouldAutoDenyInteractiveRequest()` returns only
whether `permissionEscalation === "deny"`. Its caller applies that result to
approval interactions and otherwise delegates resolution. That helper is not a
general mode-based approval engine or automatic risk reviewer. The local Pi
provider also declares only `full` while using the runtime-owned handshake;
copying that handshake does not supply restricted execution. A concrete
resolver and enforcement owner still need to be demonstrated for NanoGPT.

## Three different meanings of tools

| Location | Meaning |
| --- | --- |
| `bb.agents.configure(...).tools` | Selects tools registered by that contributing plugin. It is not a global replacement for every other plugin's tool selection. NanoGPT currently selects its hidden history tool here. |
| Bridge `dynamicTools` | bb's session tool catalog, with `name`, `description`, `inputSchema`, and optional `presentation`. |
| NanoGPT request `tools` | OpenAI-compatible function definitions derived from that catalog. They allow the model to request a call; they do not execute it. |

The SDK dynamic-tool schema inspected here contains no general read/write,
workspace-path, escalation, or trust classification. Tool names and model-authored
arguments are insufficient evidence that a tool is safe. A permission system
must supply trusted metadata or conservatively treat an unclassified tool as
requiring approval or denial.

The plugin supplies no general filesystem read/write, patch, search, or shell
execution engine. A `read_file` fixture in a bridge test is synthetic; it does
not establish a built-in file tool. Changing `permissionMode` cannot add those
tools. Adding them would require a separate host-execution design, including
workspace enforcement and Windows path behavior.

### Session changes and internal operations

Tool catalogs are captured on start/resume. This bridge does not receive a new
catalog in `turn/start`, and queued turns currently store only the reduced turn
options. A future implementation must keep each turn's complete policy snapshot
and define catalog refresh through supported session reconstruction. It must
not borrow a later queued turn's permissions for a running call.

`nanogpt_restore_history` was registered by this plugin and hidden from model tool
definitions. Baseline dispatch did not reject an unexpected model call to that
registered name, contrary to the initial audit wording. The follow-up explicitly
separates model and restoration call sources and blocks model dispatch. Restoration invokes
it directly before the resumed turn's generation, including a planning turn.
This is an internal read of the active thread's saved events, not execution of
the historical calls. The internal path must retain its thread restriction and
must not become a general exemption from future denylists or permission checks.

Attachments are also read directly by the bridge, outside `item/tool/call`.
Current code reads the paths bb stages for the submitted prompt. A future
workspace policy must explicitly address these staged attachment paths rather
than assuming a tool-only gate covers every file read. History restoration and
attachment transport do not establish an OS sandbox for full-trust plugin code.

## Evidence and verification

The local bb source inspected was `C:\Projects\bb\src`, declaring SDK 0.6.133.
Its `bb-plugin-sdk-provider-bridge.d.ts` matches the installed bundle:
SHA-256 `BC8802B2BC88CCC8A596791098272E7F0DFF0E79793F3CE7F28536F98D64AA8C`.
The checkout commit could not be established because Git access to that checkout
was denied. Bundle equality supports contract correspondence, not identity with
a deployed bb binary.

Primary implementation references, relative to this repository:

- `server.ts`: provider capabilities, option derivation, history-tool registration.
- `src/provider-bridge.ts`: `Session`, `TurnOptions`, `openSession()`,
  `turnOptionsOf()`, `toolDefinitions()`, `requestToolCall()`, start/resume and
  turn/steer handlers, plan-mode guards, and history restoration.
- `src/vocabulary.ts`: provider-specific option schema.
- `src/nano-gpt-client.ts`: completion request and tool definitions.
- `src/provider-bridge.test.ts`: functional tool-loop, plan-mode, malformed-call,
  cancellation, and history-restoration coverage.

Primary bb references, relative to the inspected local checkout:

- `packages/domain/src/shared-types.ts`: `runtimePermissionPolicySchema`.
- `packages/domain/src/provider-types.ts`: `dynamicToolSchema`.
- `packages/plugin-sdk/src/backend-contract.ts`: `PluginProviderOptionsContext`,
  `PluginAgentConfiguration`, and provider capabilities.
- `packages/provider-bridge-protocol/src/{execution-options,requests,bridge-requests}.ts`:
  wire schemas and `interaction/request` transport.
- `packages/agent-runtime/src/{execution-options,bridge-protocol-adapter,runtime-provider-requests}.ts`:
  supported-mode checks, wire conversion, separate tool/approval routing.
- `packages/provider-bridge-protocol/src/bridge-kit/permission-policy.ts`:
  escalation-denial helper.
- `apps/host-daemon/src/app.ts`: tool forwarding.
- `apps/server/src/internal/{tool-calls,interactive-requests}.ts`: separate server
  execution and pending-interaction routes.
- `docs/provider-plugin-api.md`: documented approval-subject behavior.

The public [bb runtime request implementation](https://github.com/get-bb/bb/blob/main/packages/agent-runtime/src/runtime-provider-requests.ts)
was also inspected online. Its retrieved revision differs from the local source;
it supports the separate routing observation but is not a pinned compatibility
target. Recheck source and schemas when changing the SDK version.

Verification performed for this audit:

- Installed SDK schema probes: valid tuples accepted, inconsistent tuple rejected,
  denylist retained on session construction, declared turn fields inspected.
- Available Git history inspected for prior permission implementations.
- `npm test`: 12 files, 215 tests passed.
- `npm run typecheck`: passed.

### Reproducible follow-up probes

The original probe files are in Git-ignored `dev_docs/`:

- `permissions-audit.probe.ts`: 17 historical characterization probes against the baseline
  bridge, with synthetic credentials, stubbed `fetch`, and injected tool replies.
- `permissions-audit.vitest.config.ts`: originally selected those probes; now
  selects `src/provider-permissions.test.ts`, the current acceptance coverage.

From the repository root, run:

```powershell
node node_modules/vitest/vitest.mjs run --config dev_docs/permissions-audit.vitest.config.ts
```

Baseline result on 2026-11-09: **17/17 passed**. Passing meant the reported baseline behavior
was reproduced, including the gaps. These assertions are not future acceptance
criteria and should not be copied into production regression tests unchanged.

Before implementation the regular suite passed separately: **12 files / 215 tests**, and
`npm run typecheck` passed. The regular typecheck excludes `dev_docs`; the audit
probe was executed through Vitest, not included in the production TypeScript
check. No runtime source was edited during the audit passes; follow-up runtime
changes and their verification are recorded at the top of this document.

No live permission picker, user approval, automatic review, real denied
escalation, host sandbox, or authenticated model/tool execution was verified.
Local and public source establish the routing observations; mocked probes
establish bridge behavior. Neither establishes behavior of a deployed binary.

### Pre-implementation snapshot locations

Line numbers below refer to the audited working tree and may move after edits:

| Location | Observation |
| --- | --- |
| `server.ts:212` | Only `full` is declared. |
| `src/provider-bridge.ts:1094` | `turnOptionsOf()` projects away all permission-policy fields. |
| `src/provider-bridge.ts:265` | Session tool map is built directly without a denylist or uniqueness check. |
| `src/provider-bridge.ts:352` | Advertised definitions filter only the hidden history tool. |
| `src/provider-bridge.ts:452` | Dispatch checks cancellation and known names, then sends the request. |
| `src/provider-bridge.ts:1241` | Resume reconstructs the session without `disallowedTools`. |
| `src/provider-bridge.ts:1297` | Steer queue entries retain only projected options. |
| bb `packages/agent-runtime/src/runtime-provider-requests.ts:216` | Tool calls delegate to `onToolCall()`. |
| bb `packages/agent-runtime/src/runtime-provider-requests.ts:291` | Separate interaction handler consults runtime-owned escalation policy. |

Pre-implementation runtime SHA-256 values (historical audit snapshot; these are
not hashes of the subsequent implementation):

| File | SHA-256 |
| --- | --- |
| `src/provider-bridge.ts` | `711438EA2EF1CC0D422140649053831C6F9C828E68EEF36234AE55C6E6582E6D` |
| `server.ts` | `365395A2CF3B4FCE9CF3ED3E19450F34412304AF0316CE0285DCE92F4B530B0B` |
| `src/vocabulary.ts` | `B31E0A3A816956DA8F323BAAB9345413646215060D9EF86538D11B87F3F858DE` |
