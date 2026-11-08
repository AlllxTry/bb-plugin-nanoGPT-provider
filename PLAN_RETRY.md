# Plan: Automatic Retry for Transient Errors

**Feature:** Add automatic retry logic with exponential backoff for transient HTTP errors before SSE streaming starts.

**Target version:** 0.1.5 (follow-up release)

---

## Problem Statement

Currently, when NanoGPT API returns transient errors (429 rate limit, 502 bad gateway, 503 unavailable, 504 timeout), the request fails immediately. Users must manually retry. This is especially problematic for rate limits where a brief wait would allow the request to succeed.

---

## Scope

**In scope:**
- Retry logic in `nano-gpt-client.ts` before SSE streaming
- Exponential backoff with jitter
- Respect `Retry-After` header for 429 responses
- Configurable retry parameters
- Unit tests for retry behavior

**Out of scope:**
- Retry during SSE streaming (cannot replay streamed output)
- Retry logic in provider bridge
- Live API smoke tests

---

## Implementation Phases

### Phase 1: Core Retry Logic

| Task | Description | File |
|------|-------------|------|
| 1.1 | Add retry configuration constants | `src/vocabulary.ts` |
| 1.2 | Create retry helper function with exponential backoff | `src/nano-gpt-client.ts` |
| 1.3 | Implement status code detection (429, 502, 503, 504) | `src/nano-gpt-client.ts` |
| 1.4 | Integrate retry loop into `createChatCompletion` | `src/nano-gpt-client.ts` |

**Acceptance criteria:**
- Failed requests with retryable status codes are retried
- Each retry uses longer delay (exponential backoff)
- Random jitter prevents thundering herd
- 429 responses with `Retry-After` header are respected

---

### Phase 2: Configuration & Observability

| Task | Description | File |
|------|-------------|------|
| 2.1 | Add debug logging for retries | `src/nano-gpt-client.ts` |
| 2.2 | Document retry behavior in README | `README.md` |
| 2.3 | Add environment variable overrides for testing | `src/vocabulary.ts` |

**Acceptance criteria:**
- Each retry attempt is logged with delay duration
- Users can understand why requests take longer
- Developers can disable/adjust retries via env vars

---

### Phase 3: Testing

| Task | Description | File |
|------|-------------|------|
| 3.1 | Add unit tests for backoff calculation | `src/nano-gpt-client.test.ts` |
| 3.2 | Add tests for status code detection | `src/nano-gpt-client.test.ts` |
| 3.3 | Add integration test with mock 429 → 200 | `src/nano-gpt-client.test.ts` |
| 3.4 | Add test for Retry-After header handling | `src/nano-gpt-client.test.ts` |

**Acceptance criteria:**
- All new tests pass
- Existing tests still pass
- Timing-sensitive tests use mocked timers

---

## Configuration Options

```typescript
// Suggested defaults in vocabulary.ts
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterMs: 500,
  retryableStatusCodes: [429, 502, 503, 504],
};

// Environment overrides
// NANOGPT_MAX_RETRIES=0 (disable)
// NANOGPT_RETRY_DELAY=2000
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Retry delays cause timeout | Low | Respect overall request timeout |
| Infinite retry loop on persistent failure | Medium | Hard limit on attempts |
| Jitter timing test flakiness | Low | Use vitest fake timers |

---

## Alternative Approaches Considered

**Fixed delay retry (rejected):** Simpler but not optimal for rate limits. Exponential backoff is industry standard.

**Retry during streaming (out of scope):** Cannot replay SSE output. Would need to cache and replay which adds complexity.

---

## Success Criteria

1. Request that gets 429 → waits → retries → succeeds
2. Request that gets 502 three times → fails with clear error
3. All 162 existing tests pass + new retry tests pass
4. Documentation updated