# Reasoning Effort

This guide describes the released implementation as of package version 0.1.5.
See [the changelog](../CHANGELOG.md) for the release boundary.

## Choosing an effort

Select a NanoGPT model in bb, then use the reasoning picker. Every model offers
**Provider default**. Low, Medium, and High appear only when the detailed catalog
advertises those exact values for the selected model. A model can offer a subset,
such as High alone. Missing or unusable metadata leaves Provider default available.

Provider default leaves the upstream reasoning policy unchanged. Explicit Medium
sends an override, so it can behave differently from Provider default. Visible
reasoning text is independent of the selection: a successful request can return
an answer without a separate reasoning stream.

| Picker label / incoming value | bb wire ID | Completion request |
| --- | --- | --- |
| Provider default | `nanogpt:provider-default` | Omit `reasoning_effort`. |
| Low | `nanogpt:effort:low` | `reasoning_effort: "low"` |
| Medium | `nanogpt:effort:medium` | `reasoning_effort: "medium"` |
| High | `nanogpt:effort:high` | `reasoning_effort: "high"` |
| Legacy saved default | Bare `medium` | Omit `reasoning_effort`. |
| Missing, null, or empty selection | No explicit wire ID | Omit `reasoning_effort`. |

Other picker IDs fail locally. The plugin does not map model names to native
thinking budgets or infer unsupported levels from a generic reasoning flag.
Levels such as `none`, `minimal`, `xhigh`, and `max` are outside the implemented
subset, even if the upstream advertises them.

## Catalog discovery and bb's cache

The bridge requests `GET <baseUrl>/models?detailed=true` with the effective key.
The client preserves each model's optional `reasoning_efforts` field. The shared
policy accepts string arrays, keeps only Low / Medium / High, removes duplicates,
and returns them in that order. Malformed optional metadata does not discard an
otherwise valid model ID. Duplicate model records with different effort metadata
reduce that model to Provider default only.

HTTP 400, 404, 405, or 422 from detailed discovery triggers a basic
`GET <baseUrl>/models` request. That fallback supplies IDs only; even effort fields
present in its response are ignored. Authentication errors, transport failures,
timeouts, and malformed successful responses do not trigger this fallback.

One 10-second deadline covers the detailed lookup, optional fallback, and their
response-body parsing. The fallback receives only the remaining time. Completion
retry rules do not apply to catalog requests. A failed `model/list` returns an
empty model list; it does not prove that the saved key is invalid.

All returned model records use `reasoningDiscovery: "known"`. This marks the
plugin's picker options as authoritative, including a default-only option set.
It does not assert that missing upstream metadata has been discovered. The
distinction matters because bb preserves previous known options when a later
record is marked `unknown`; doing so could leave stale High options visible.

The bridge capability cache has a five-minute TTL and a maximum of 16
endpoint/credential identities. A SHA-256 digest of the normalized endpoint and
key identifies each entry. Each entry contains a map indexed by model ID.
Successful reuse updates eviction order without extending the TTL. Picker
`model/list` requests force a refresh. This cache is separate from the API-key
validation cache described in [the README](../README.md#how-the-api-key-gate-works).

## Turn execution

The SDK supplies effort in `options.reasoningLevel`. `turnOptionsOf()` preserves
it for ordinary and queued/steered turns; it is not a second provider-specific
setting. Before appending the current prompt or generating output, the bridge:

1. Resolves the effective model, endpoint, credentials, and selection.
2. Skips capability discovery for Provider default.
3. For an explicit selection, loads the endpoint/account catalog and validates
   that model's supported subset.
4. If a still-valid cached entry rejects the selection, refreshes once and
   validates again. A cold or expired lookup that rejects does not fetch twice.
5. Fixes the resolved effort for every completion/tool round of the turn.

Each catalog lookup has its own 10-second operation deadline. The initial lookup
and an optional forced refresh are separate operations; the whole turn has no
single catalog/retry deadline. Stop cancels discovery through the turn signal.

The HTTP client adds exactly one top-level `reasoning_effort` when explicit.
It does not also add `reasoning.effort` or imitate effort through prompt text.
Automatic transport retries reuse the same request body. Plan mode retains the
selection while omitting executable model tools.

If the selected effort remains unsupported, the turn fails before a completion
request with `NanoGPT model does not declare high reasoning effort` (or the
selected level). Choose Provider default, another offered level, or refresh the
catalog. The bridge does not silently downgrade an explicit choice.

An upstream HTTP 400 whose error mentions reasoning, effort, or thinking
invalidates the endpoint/account capability entry after an explicit request.
The error still fails the turn; there is no automatic retry with effort removed.
A later explicit turn discovers capabilities again. Other HTTP errors retain
the usual client failure/retry behavior.

## Implementation map

| File | Responsibility |
| --- | --- |
| [`src/reasoning.ts`](../src/reasoning.ts) | Wire IDs, supported subset, labels, compatibility, and validation. |
| [`server.ts`](../server.ts) | Provider descriptors and empty pre-auth fallback catalog. |
| [`src/nano-gpt-client.ts`](../src/nano-gpt-client.ts) | Detailed/basic discovery, shared deadline, and request serialization. |
| [`src/provider-bridge.ts`](../src/provider-bridge.ts) | Catalog cache, authoritative picker metadata, selection snapshot, validation, and invalidation. |
| [`src/vocabulary.ts`](../src/vocabulary.ts) | Preferred models, provider options, and default metadata. |

## Verification and remaining work

On 2026-11-09, `npm.cmd test` passed all **215 tests across 12 files**, and
`npm.cmd run typecheck` passed. Tests use synthetic catalog fixtures and stubbed
HTTP requests. These results establish the tested local behavior; no live
composer-to-request or authenticated NanoGPT check was performed in this review.

The three issues from the thinking-effort review have production-code changes
in the current working tree: authoritative default-only records, one refresh
after cached rejection, and a shared detailed/fallback deadline. Dedicated
regression coverage remains incomplete. Add these checks before calling the
review fully closed:

| Priority | Regression / acceptance check | Expected evidence |
| --- | --- | --- |
| P2 | High metadata followed by missing, malformed, conflicting, or basic-only metadata, through bb's catalog consumer | Previous explicit options disappear; Provider default remains. |
| P2 | Cached negative lookup followed by fresh support, continued rejection, or refresh failure | Exactly one refresh; generation only after verified support; no refresh loop. |
| P2 | Detailed response at 9 seconds followed by a stalled basic lookup | Timeout at 10 seconds total; caller abort also ends discovery. |
| P2 | Cache TTL, eviction, and conflicting model/endpoint/account capabilities | No cross-identity reuse; expired/evicted entries are fetched again. |
| P2 | Upstream effort-related HTTP 400, then a new explicit turn | Invalidation causes rediscovery; no silent effort downgrade. |
| P2 | Stop during detailed discovery or fallback | No late generation or output after settlement. |
| P2 | Different choices on queued and steered turns; explicit effort in plan mode and retries | Each captured request carries that turn's selected effort. |
| Release | Sanitized real detailed-catalog fixtures | Actual field shapes and supported subsets are established without storing keys. |
| Release | Real composer selection, dispatch, and tool continuation | Custom IDs survive the host path and reach each authenticated request. |

For live acceptance, also reopen a thread saved with bare `medium`, switch to a
model with a smaller supported subset, and inspect request omission for Provider
default. Reasoning length or answer quality alone cannot verify the wire value.
Record bb/SDK versions and distinguish real upstream responses from local mocks.
