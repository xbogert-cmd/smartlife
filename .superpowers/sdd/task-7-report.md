# Task 7 Report: FallbackProvider

## Summary

Implemented `src/main/ai/providers/fallback.ts` and its test file exactly as
specified in the task brief (`task-7-brief.md`), following TDD:

1. Wrote `src/main/ai/providers/fallback.test.ts` verbatim from the brief.
2. Ran it — confirmed RED: `Failed to resolve import "./fallback"` (module
   didn't exist yet).
3. Wrote `src/main/ai/providers/fallback.ts` verbatim from the brief.
4. Ran the scoped test file — all 7 tests GREEN.
5. Ran the full suite and typecheck.
6. Committed.

No deviations from the brief. I read the implementation closely before
transcribing it (see "cost-rank ceiling verification" below) looking for a
concrete bug to justify a fix, and did not find one — the logic as given is
internally consistent and every test scenario traces through correctly by
hand, so I left it exactly as written.

## Interfaces produced

`src/main/ai/providers/fallback.ts` exports, matching the brief's spec
exactly:
- `RankedEntry { providerId, model, displayName, costRank, provider }`
- `FallbackOptions { pinned?: { providerId, model } }`
- `RetryableFallbackProvider extends AIProvider { retryEntry(providerId, model): void }`
- `createFallbackProvider(entries, options?): RetryableFallbackProvider`

It consumes `AIProvider`, `ProviderId`, `StreamEvent` from `./types` (Task 1),
which already matched the brief's expected shapes with no changes needed.

## How the cost-rank ceiling actually holds (walked through, not just "tests pass")

The core loop in `streamTurn`:
- Picks a starting entry: the pinned entry if `options.pinned` is set and
  found, otherwise `entries[0]`.
- If the starting entry is already in the sticky `failed` Set, it skips
  straight to `nextCandidate(start.costRank, triedThisTurn)` instead of
  calling it.
- On each failure of the `current` entry, it marks that entry failed and
  looks for `nextCandidate(current.costRank, triedThisTurn)` — i.e. the
  ceiling used for the *next* hop is the cost rank of the entry that just
  failed, not the original starting entry's rank.
- If no candidate is found at or below that ceiling, it throws
  `Everything tried failed: <displayNames>. <last error message>` and never
  calls anything higher-cost.

Concrete walk-through (this is test 3, "does not automatically cross into a
higher cost rank than the starting entry", traced by hand against the actual
code, not just observed as a passing assertion):

- Entries: `Flash` (gemini, costRank 1) then `Opus` (anthropic, costRank 5).
- `startingEntry()` → `entries[0]` = Flash (not pinned, not previously
  failed).
- Loop: `current = Flash`. `Flash.provider.streamTurn()` throws `boom`.
- `failed.add('gemini:flash')`.
- `nextCandidate(1, {gemini:flash})` — filters `entries` for
  `costRank <= 1 && !failed && !tried`. Opus has `costRank 5`, which fails
  `costRank <= 1`, so it is excluded regardless of failed/tried status.
  Result: `undefined`.
- Since `next` is `undefined`, the function throws
  `Everything tried failed: Flash. boom` and returns — `Opus.provider.streamTurn`
  is never invoked. The test asserts exactly this
  (`expect(pricier.streamTurn).not.toHaveBeenCalled()`), and it passes.

This demonstrates the ceiling is enforced structurally (an array `.find()`
predicate gating on `costRank <=`), not by convention or ordering — even if
`Opus` had been first in the `entries` array, the `costRank <= atOrBelowCostRank`
guard would still exclude it.

One property worth calling out explicitly since it's not spelled out in the
brief's prose but is what the code actually does: the ceiling *ratchets down*
on each hop rather than staying pinned to the original starting entry's rank.
E.g. if the starting entry has `costRank 5` and fails over to a `costRank 3`
entry, and *that* one also fails, the next search uses ceiling `3` (not `5`)
— so it could not hop back up to a hypothetical `costRank 4` entry even
though `4 <= 5`. This is a stricter, more conservative interpretation of
"never escalate" than the docstring's literal wording ("<= the starting
entry's") suggests, but it's strictly safer, not looser, so I did not treat
it as a bug to fix. I'm flagging it here per the brief's request to be
explicit about the ceiling's exact behavior, not silently fixing/changing it.

The sixth test (manual pin) confirms the same ceiling logic applies starting
from a pinned mid-rank entry rather than `entries[0]`: pin is `Sonnet`
(costRank 3), which fails; fallback moves to `Flash` (costRank 1, <= 3) and
succeeds; `Opus` (costRank 5) is never touched.

## Sticky-failure verification

Test 4 confirms failures persist across separate `streamTurn` calls on the
same `FallbackProvider` instance (the closure-scoped `failed` Set is not
turn-scoped) — the entry is skipped on lookup, not retried and re-failed.
Test 5 confirms `retryEntry(providerId, model)` deletes the entry from that
same `failed` Set, so a later call resumes trying it.

## Test results

Scoped: `npm test -- src/main/ai/providers/fallback.test.ts` → 7/7 passed.

Full suite: `npm test` (no path filter) → **1157 passed, 1 failed** out of
1158 tests across 109 files.

The one failure is the documented pre-existing flake:
`src/renderer/src/routes/Home.test.tsx > Home route > shows an assignment due
earlier today in the Today agenda` — the midnight-boundary date test. I
confirmed this is time-of-day-dependent and not caused by this change: I ran
it in isolation (`npm test -- src/renderer/src/routes/Home.test.tsx`) at
~00:41 local time and it failed the same way ("Nothing scheduled today"
instead of finding "Morning problem set" in the Today section) — consistent
with the known midnight-boundary flake, unrelated to `fallback.ts`. No other
test failed; the `ThemeProvider.test.tsx` flake did not appear in this run.

`npm run typecheck` → clean, no errors.

`npm run lint` → 8 pre-existing errors / 3 warnings, all in files unrelated
to this task (`browser/refs.test.ts`, `useConversation.test.ts`,
`usePendingConfirmationBadge.test.ts`, `nav/Sidebar.test.tsx`,
`routes/AI.test.tsx`, `browser/extract.test.ts`). Neither `fallback.ts` nor
`fallback.test.ts` appears in the lint output.

## Commit

`8bb7459` — "Add FallbackProvider: ordered retry with sticky failures and a
cost-rank ceiling"

Files: `src/main/ai/providers/fallback.ts`,
`src/main/ai/providers/fallback.test.ts`.

---

## Follow-up: fixed the cost-rank ceiling ratchet-down defect

A later task review correctly identified that the "ceiling ratchets down on
each hop" behavior called out above was not a safe, stricter interpretation
— it was a real defect. The original report reasoned that ratcheting the
ceiling down to `current.costRank` (the just-failed entry's own rank) on
each hop was merely "stricter" than pinning it to `start.costRank`. That
reasoning was wrong: the ceiling is supposed to bound how high the *turn*
can escalate above where it *started*, not shrink further with every failed
hop. Shrinking it needlessly excludes untried, in-budget entries and causes
the turn to give up and throw even when a perfectly good candidate at or
below the original ceiling was never attempted.

### Root cause

In `streamTurn`'s catch block (`src/main/ai/providers/fallback.ts`, line 72),
`nextCandidate` was called with `current.costRank` — the rank of the entry
that just failed — instead of `start.costRank`, the rank of the entry the
whole turn started from (captured once at the top of `streamTurn`). Since
`nextCandidate` only returns entries with `costRank <= ` the value passed in,
using `current.costRank` caused the ceiling to ratchet down with every hop
instead of staying fixed at the original starting rank.

Concrete failure mode: with entries `[Haiku(1), Sonnet(3), Opus(5)]` (the
catalog's real, natural ascending-by-cost order) and the turn pinned to
start at Opus(5):
1. Opus fails. Ceiling for the next hop is (correctly) 5 → finds Haiku(1)
   first in array order → tries Haiku.
2. Haiku also fails. Bug: ceiling for the next hop becomes `current.costRank`
   = 1 (Haiku's own rank), not 5. Sonnet(3) fails `3 <= 1` and is wrongly
   excluded. The turn throws "Everything tried failed: Opus, Haiku" even
   though Sonnet — well within the original ceiling of 5 — was never tried.

### Fix

One-token change on line 72:

```diff
-          const next = nextCandidate(current.costRank, triedThisTurn);
+          const next = nextCandidate(start.costRank, triedThisTurn);
```

`start` was already captured once per `streamTurn` call and already in
scope; the fix simply uses it consistently for every hop's ceiling check
instead of the per-hop `current`. Line 63 (the pre-loop lookup) already used
`start.costRank` correctly and was untouched. The doc comment above
`createFallbackProvider` already read "the starting entry's" (not "the
previously-tried entry's"), so it was already accurate and needed no edit.

### Regression test added

Added to `src/main/ai/providers/fallback.test.ts`:
`'keeps the cost-rank ceiling fixed at the starting entry across multiple
hops, not ratcheting down further with each failure'`. Scenario: pinned
start at Opus(5, fails) → hops to Llama/cheapest(1, fails) → must still
reach Sonnet(3, succeeds) because 3 <= the original ceiling of 5, not
because 3 <= 1. Also asserts Opus's `streamTurn` was called exactly once
(never retried within the same turn thanks to sticky failure memory).

### Verification that the test catches the bug

Temporarily reverted only the one-line fix (kept the new test in place) and
reran `npm test -- src/main/ai/providers/fallback.test.ts`:

- Pre-fix (buggy `current.costRank`): new test **failed** with
  `Error: Everything tried failed: Opus, Llama 3.1. boom` — exactly the
  predicted failure mode.
- Post-fix (`start.costRank` restored): all 8 tests **passed**.

This confirms the test genuinely exercises and catches the defect, not just
that it happens to pass against the fixed code.

### Full verification after the fix

- `npm test -- src/main/ai/providers/fallback.test.ts` → 8/8 passed.
- `npm test` (full suite) → 1158/1159 passed. The one failure is the
  documented pre-existing flake, `Home.test.tsx`'s midnight-boundary Today
  agenda test ("Nothing scheduled today" instead of finding "Morning problem
  set") — unrelated to this change. `ThemeProvider.test.tsx`'s DOM-attribute
  race flake did not appear in this run.
- `npm run typecheck` → clean, no errors.

### Commit

Files: `src/main/ai/providers/fallback.ts`,
`src/main/ai/providers/fallback.test.ts`, this report.
