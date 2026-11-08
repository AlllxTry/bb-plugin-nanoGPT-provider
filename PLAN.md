# NanoGPT Provider — Plan & Implementation Summary

## Goal
Add retry logic for transient HTTP errors (429, 502, 503, 504) in `streamChatCompletion` with exponential backoff + jitter.

---

## Plan

### Phase 1: Configuration
- [x] Add `RETRY_CONFIG` to `src/vocabulary.ts`
  - `maxRetries: 3`
  - `baseDelayMs: 1000`
  - `maxDelayMs: 10_000`
  - `jitterMs: 500`
  - `retryableStatusCodes: [429, 502, 503, 504]`

### Phase 2: Retry Helpers in `nano-gpt-client.ts`
- [x] Import `RETRY_CONFIG` from vocabulary
- [x] Add `debug` logger (enabled via `NANOGPT_DEBUG=1`)
- [x] Add `isRetryableStatus(status)` — checks against retryable codes
- [x] Add `calculateRetryDelay(attempt, response)` — exponential backoff + jitter, respects `Retry-After` header on 429
- [x] Add `sleep(ms, signal)` — cancellable sleep respecting abort signal

### Phase 3: Retry Loop in `streamChatCompletion`
- [x] Wrap only the **fetch call** in a retry loop (not the entire streaming)
- [x] On network error / timeout during fetch → retry if attempts remain
- [x] On non-ok response:
  - Read error body first via `fail()` to get API message
  - If reading error body times out → throw `NanoGptTimeoutError` immediately (don't retry)
  - If status is retryable → continue to next attempt
  - If status is not retryable → throw immediately
- [x] On success → exit loop via `return`
- [x] After exhausting retries → throw `NanoGptApiError` with attempt count

### Phase 4: Tests
- [x] All 162 existing tests pass
- [x] Timeout tests still work correctly (headers, body, error body stages)

---

## Files Changed

| File | Changes |
|------|---------|
| `src/vocabulary.ts` | Added `RETRY_CONFIG` constant |
| `src/nano-gpt-client.ts` | Added retry helpers + wrapped fetch in retry loop |

---

## Key Design Decisions

1. **Retry only the fetch, not streaming** — once a 200 response is received, stream it to completion. Retrying mid-stream would lose already-delivered tokens.
2. **Timeouts are not retried** — `NanoGptTimeoutError` and `AbortError` propagate immediately; only transient HTTP errors (429/502/503/504) trigger retries.
3. **Exponential backoff with jitter** — prevents thundering herd; caps at 10s; respects `Retry-After` header on 429.
4. **Debug logging** — enabled via `NANOGPT_DEBUG=1` env var, logs each retry attempt and delay.

---

## Verification

```bash
npm run typecheck   # ✅ passes
npm test            # ✅ 162/162 tests pass
```
