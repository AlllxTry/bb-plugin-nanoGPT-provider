# Plan: Session History Persistence

**Feature:** Persist conversation history to survive daemon restarts using SQLite.

**Target version:** 0.1.6 (follow-up release)

---

## Problem Statement

Currently, session history lives in memory only. When the bb daemon restarts, all conversation context is lost. Users must re-explain context in each new session, which is especially problematic for long-running conversations or complex projects.

---

## Scope

**In scope:**
- SQLite-based storage in plugin data directory
- Persist session on each turn completion
- Load existing session on thread start
- Handle thread release (cleanup or retain)
- Unit tests for storage operations

**Out of scope:**
- Cross-platform sync (not needed, single-user)
- Session encryption (low priority)
- Import/export functionality
- Migration from other storage formats

---

## Implementation Phases

### Phase 1: Storage Infrastructure

| Task | Description | File |
|------|-------------|------|
| 1.1 | Initialize SQLite database in plugin data dir | `src/session-store.ts` |
| 1.2 | Create schema: sessions + messages tables | `src/session-store.ts` |
| 1.3 | Implement `saveSession(threadId, messages)` | `src/session-store.ts` |
| 1.4 | Implement `loadSession(threadId)` | `src/session-store.ts` |
| 1.5 | Implement `deleteSession(threadId)` | `src/session-store.ts` |

**Acceptance criteria:**
- Database created on first run
- Sessions saved to disk
- Sessions restored on load
- No data corruption on crashes

---

### Phase 2: Provider Bridge Integration

| Task | Description | File |
|------|-------------|------|
| 2.1 | Import session store in provider bridge | `src/provider-bridge.ts` |
| 2.2 | Load session on `threadStart` | `src/provider-bridge.ts` |
| 2.3 | Save session after each turn completes | `src/provider-bridge.ts` |
| 2.4 | Handle `threadStop` gracefully | `src/provider-bridge.ts` |
| 2.5 | Handle `threadRelease` (cleanup option) | `src/provider-bridge.ts` |

**Acceptance criteria:**
- New thread starts with fresh history
- Existing thread resumes with full history
- History survives daemon restart
- Stop does not delete history

---

### Phase 3: Data Management

| Task | Description | File |
|------|-------------|------|
| 3.1 | Add session age-based cleanup (optional) | `src/session-store.ts` |
| 3.2 | Add max storage size limit | `src/session-store.ts` |
| 3.3 | Handle storage errors gracefully | `src/session-store.ts` |
| 3.4 | Log storage operations for debugging | `src/session-store.ts` |

**Acceptance criteria:**
- Disk usage bounded
- Old sessions auto-cleaned
- Storage failures don't crash plugin

---

### Phase 4: Testing

| Task | Description | File |
|------|-------------|------|
| 4.1 | Add unit tests for session store CRUD | `src/session-store.test.ts` |
| 4.2 | Add tests for data persistence across restarts | `src/session-store.test.ts` |
| 4.3 | Add tests for error handling | `src/session-store.test.ts` |
| 4.4 | Integration test with provider bridge | `src/provider-bridge.test.ts` |

**Acceptance criteria:**
- All new tests pass
- Existing tests still pass (162+)
- Storage works on Windows/Unix

---

## Database Schema

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT UNIQUE NOT NULL,
  provider_thread_id TEXT,
  cwd TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_sessions_thread ON sessions(thread_id);
```

---

## Configuration Options

```typescript
// In vocabulary.ts or settings
const STORAGE_CONFIG = {
  maxAgeDays: 30,        // Auto-delete sessions older than 30 days
  maxStorageMb: 100,     // Max 100MB for all sessions
  maxMessagesPerSession: 1000,
};
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| SQLite file corruption | Medium | Use WAL mode, handle errors gracefully |
| Disk space exhaustion | Medium | Enforce max storage limit |
| Performance on large history | Low | Index optimization, pagination |
| Concurrency issues | Low | SQLite handles concurrent reads |

---

## Alternative Approaches Considered

**JSON file storage (rejected):** Simpler but no concurrent access control, higher corruption risk.

**bb built-in persistence (not available):** No native provider session storage API exists.

---

## Success Criteria

1. Session persists after daemon restart
2. 500-message conversation survives restart
3. Storage limited to configured max size
4. All 162+ existing tests pass + new tests pass
5. No data loss on normal operations