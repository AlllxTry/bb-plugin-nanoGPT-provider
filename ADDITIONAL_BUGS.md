# Additional Bugs Found (Not in FIX_PLAN.md)

## Analysis Date: 2026-11-08

After reviewing the codebase, here are issues **not covered** by the existing 26-item FIX_PLAN.md:

---

## 1. Attachments — Generic Error Messages

**File:** `src/attachments.ts:53-56`

All errors (permission denied, file not found, disk full) return the same message. No differentiation for the user.

```typescript
} catch {
  signal?.throwIfAborted();
  return `[Attached file "${name}" could not be read; its contents are not available to you.]`;
}
```

---

## 2. Settings Popup — baseUrlEdit State Leak

**File:** `src/settings-popup.tsx:21, 25`

After successful save, `baseUrlEdit` resets to null. But if user started editing then clicked Close, the value persists in state and may reappear on next open.

```typescript
const [baseUrlEdit, setBaseUrlEdit] = useState<string | null>(null);
const baseUrl = baseUrlEdit ?? status?.baseUrl ?? "";
```

---

## 3. Provider Bridge — Silent Response Ignoring

**File:** `src/provider-bridge.ts:1185-1189`

If a response arrives for a non-existent tool call (already cancelled or session replaced), it's silently ignored without logging. Makes debugging difficult.

```typescript
const pending = pendingToolCalls.get(parsed.data.id);
if (pending === undefined) {
  return;
}
```

---

## 4. No Model ID Validation

The model ID is passed directly from context without validation. Invalid ID may cause unclear API errors.

---

## Already Documented in FIX_PLAN.md (for reference)

These are already covered by the existing plan:

- Key-gate caching issues ("Additional findings" section)
- Retry logic missing ("Additional findings" section)
- Image token estimation (Phase 4, #21)
- Context window verification (Phase 4, #21)
- Hardcoded context window size 32768 (Phase 4, #21)
- Context trimming persistence limitation (section "Repository scope")