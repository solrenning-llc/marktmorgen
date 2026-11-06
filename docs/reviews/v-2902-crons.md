# Codex V review evidence for #2902

Reviewed head: `e017819d2b111d2cb475532f3af6fbd27d497049`.

## Finding

`app/api/cron/quiet/route.ts` accepts any decimal text from `0` through nine
digits as a cursor, without checking that it is at most the number of folders
in the current pass. The pull request rejects `1e9`, but `999999999` has the
same effect: the loop reads no store, answers 200, and keeps the oversized
cursor. Every later run that day therefore also reads no store.

This is a LEVE correctness finding. A malformed but syntactically numeric
cursor still becomes proof that the day is complete. It should be refused (or
otherwise conservatively bounded) before the loop.

## Reproduction

The permanent proof is `tests/v-2902-cron-cursor-bound.proof.ts`. It creates one
real synthetic store and folder, writes `999999999` to today's quiet cursor,
and calls the real cron route.

```text
TMPDIR=<existing-directory> node tests/g-proof-run.mjs v-2902-cron-cursor-bound.proof.ts

Quiet cron cursor is bounded by the folders read for this pass
  FAIL  an out-of-range whole-number cursor is unknown
        expected 503
        got      200
  ok    the unknown cursor is not rewritten as a completed pass

2 checks, 1 failing.
```

The author's test remains green on the reviewed head: 24/24 checks.

No product source, author branch, workflow, external service, or real account
was changed or contacted by this evidence branch.
