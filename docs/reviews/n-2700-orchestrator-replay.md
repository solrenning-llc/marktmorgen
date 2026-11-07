# #2700 orchestrator dependency replay — local evidence

Status: MEDIUM remains open. No approval, merge, product edit, source ownership
transfer, CI rerun, or pushed reference is implied. Prepared under C4-3050/3070.

## Pinned inputs and provenance

- Product head: `ba14e9a2eb63bd3f73a02105f4da84ec49051c87`.
- `lib/mail-clicks.ts`: `2621968b57af0e8d6826200591a4c7c7d44149e7`.
- BA14 `lib/person-erasure.ts`: `13b3838a78e6c0496cc9e1c30cbfaec77cbf8841`.
- C6 handoff: `claude6/handoff-tests@3407853e`, original path
  `tests/handoff/mail-clicks-exact.test.ts`, blob
  `ad0d51cf35553a94426c07b4dc953b5224e4dced`. The local root-tests copy is
  byte-identical; its relative fixture imports resolve to canonical BA14 helpers.
- P proof: `codex/p-review-n2700-erasure-token@c4e7cf2f9e57cd01724ec436de34ff8a7336b3fb`,
  blob `9378e6db2d1b1248adb70b839bd7d995ccec4993`. Unchanged, including assertions.
- C6 occupied source, read only:
  `f444acc1c3e9c7f1e166a9d5bdd6817b6edd3815`.

After the host reset, 2,166 reconstructed tracked files were checked against
the BA14 recursive tree using Git blob hashes; zero mismatches remained before
execution. Of these, 2,007 were recovered by reading an existing local snapshot
and copying only files whose hashes matched BA14; the others were fetched by
their exact GitHub blobs. No foreign worktree, reference, dependency, or source
was edited. This is a partial snapshot sufficient for these bundles, not a full
Git checkout, full-suite verification, or assertion about unmaterialized files.

The existing dependency directory was read without installation: Node 24.22.1,
esbuild 0.28.2, TypeScript 5.9.3, Next 16.4.2, React 19.2.8. Canonical
`testAliases`/`testEnvironment` are used. The Redis backend is MemoryRedis,
not native Redis. A global fetch guard forbids external network calls.

## Executed results

1. C6's SAME 27 tests on BA14: **26 pass / 1 causal failure**, 193 synthetic
   commands. The real `erasePerson` case fails at its assertion that
   `result.failed` includes `lib/contacts.ts`. Earlier assertions confirm an
   incomplete erasure and a failed mail-click module. Later assertions in that
   particular test do not execute after this failure; no successful real-flow
   retry or marker deletion is claimed.
2. P's SAME one test on BA14: **0 pass / 1 causal failure**, 9 commands. The
   marker is still the original synthetic token instead of null after the
   explicit contact deletion and healthy `forgetClicksPerson` retry. This test
   deliberately calls `forgetContactPerson` unconditionally; preserve it as the
   original demonstration, not as a future GREEN for an orchestrator-only fix.
3. Validation of the new portable runner with the SAME P test: the same one
   causal failure, 9 commands, 179 bundled inputs. This repeats result 2 to test
   the new runner, not a second independent finding. No union test was run.

Totals: 28 distinct assertions-as-tests across two published proofs, three
test processes, 211 synthetic commands. An earlier ESM setup attempt stopped
before any test on a Next.js `__dirname` loader error; it is excluded from
product RED counts. The harness was corrected to CommonJS, without changing
proof assertions, fixtures, aliases, or any product source.

Before execution, the admitted budget was at most 30 scenarios per process,
10,000 synthetic commands per case / 100,000 total, and 120 seconds per process.
The dispatch wrapper checks the command ceiling before calling the backend.
The portable runner bounds captured output to 256 KiB and forbids downloads,
provider calls, or dependency installation. The third admitted process was
used to validate the portable runner after the proposed full-blob union was
rejected by the diff precondition. No fourth process was started.

## Composition boundary: the full C6 blob is not just three hunks

The exact C6 blob differs from BA14 in SIX unified-diff hunks. Three are the
proposed dependency change: Eraser.after, contacts.after, and the failure guard
in the loop. Three OTHER hunks pass `s.store` to `forgetFormsPerson`,
`forgetCertificatesPerson`, and `forgetLessonCommentsPerson`. They are not
silently transplanted or certified as part of this N fix.

The source was therefore not overlaid, patched, or compiled as the proposed
three-hunk union. A GREEN for BA14 plus the three scoped C6 hunks remains
unexecuted and requires explicit C4/C6 ownership/order coordination. The full
occupied source and both product references remain untouched. Credit for the
dependency design and 27-case handoff belongs to C6; credit for the original
retained-token finding and direct proof belongs to P.

## Reproduction

Place the two original published proof files unchanged at the names in this
evidence directory under an exact BA14 snapshot's `tests/`. Supply an existing
compatible node_modules directory; this script performs no installation.

```sh
node proofs/n/2700-orchestrator-replay.mjs "$BA14_ROOT" "$NODE_MODULES" "$BA14_ROOT/tests/p-2700-erasure-token-dependency.test.ts"
node proofs/n/2700-orchestrator-replay.mjs "$BA14_ROOT" "$NODE_MODULES" "$BA14_ROOT/tests/n-2700-c6-handoff.test.ts"
```

Both currently exit 1 for the causal failures above. The runner verifies the
proof blob and three critical source/config identities before bundling. The
complete original execution logs accompany this report. Syntax was checked
for the runner; no new product type/lint/full-scanner/linked-suite/nine-CI
success is claimed because no product correction has been applied.

Next: grant scoped ownership or a legitimate stacked order; only then add a
permanent real-flow RED before the source change, run the exact combined
tests/linked/types/lint/scanner, obtain P/R2 closure and nine NEW exact checks
after MAIN VERDE. The C4-3070 main order is #2940 then #2894. No consumed job is
retried. Five N products remain open; this evidence is not a sixth product.
