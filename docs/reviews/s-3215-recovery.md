# New durable evidence for existing #3215 findings

Codex S, existing SECOND financial review claim6719101825, continued under claim6722472702 and channel RES829ad8bdb05a003cece65d359bef631a07da48c6 (read back exact BEFORE new fixture/code). Subject EXACT d055c89729b8a9d6dda210e905ffc9342c0591d4. These sources and logs are NEW. The lost original local artifacts described in6719211131 were not recovered or reconstructed as originals. First independent-review credit remains Claude2/6718567045. No third review or author-source edit.

## Result

Both previously reported HIGH cursor-starvation causes remain reproduced. A recipient returning a persistent synthetic422 pins the cursor before that member, starving members subsequently inserted before the cursor.

- `lib/billing-reminders.ts:62,73-74`: a failed callback sets stopAt to the preceding subscription. The next run uses starting_after at that preceding subscription; each failure renews the pin. The NEW billing probe starts [healthyA, refusedB, healthyC], inserts newcomerN before A, runs three more times, then heals B. OLD production modules:5PASS. Subject:5checks/1FAIL, only newcomerN's timely notice (expected1, got0). Four healthy/recovery/no-duplicate assertions pass at both versions. Subject cursor sub_SFirst1108; OLD cursor absent.
- `lib/payment-recovery.ts:536-546`: failed card notice pins stopAt/from and moveCursor persists it. The NEW card probe has three members, two due cards, refuses member1, allows member2, then inserts a new due member before the list and runs four more times. OLD:5PASS. Subject:5checks/1FAIL, only newcomer notice(expected1,got0). Recovery and no-duplicate controls pass at both versions. Subject cursor sub_srecoverRun0000; OLD cursor absent. Global HOLD_RUNS does not clear this per-store card cursor.

This is evidence of missed notification in a synthetic reachable list order, not an actual payment, production incident or measured financial loss. Fix belongs to the author in the existing PR. Retain same business oracles, failed-work retry, exact unknown handling, funded preflight and no duplicate sends. Do not weaken expected newcomer count to make RED pass.

## Reproduction and bounds

The runner uses official testAliases/testEnvironment. OLD overlays ONLY the exact two modules from durable author RED parent fd22ec690a88e348fc37653b9396a1def4f56e18 into the FINAL graph; it is NOT a full old checkout. Both modules were unchanged in that parent; original author tests are not modified. Fixture setup derives from the author's tracked tests. Existing registered synthetic Resend credential is used, avoiding the earlier lost-run fixture-admission failure. Same assertions and fixtures at OLD and subject.

```
npm ci --ignore-scripts --no-audit --no-fund
node proofs/s/3215-recovery/run.mjs tests/s-3215-recovered-billing.proof.ts old
node proofs/s/3215-recovery/run.mjs tests/s-3215-recovered-billing.proof.ts
node proofs/s/3215-recovery/run.mjs tests/s-3215-recovered-card.proof.ts old
node proofs/s/3215-recovery/run.mjs tests/s-3215-recovered-card.proof.ts
node proofs/s/3215-recovery/run.mjs tests/recovery-marks-exact.test.ts
```

Expected process exits0,1,0,1,0 respectively; the two nonzero exits are intended regression proofs, not harness failures. Each output JSON contains complete stdout/stderr/status/signal/error, subject/parent identities and execution mode. No old stderr was fabricated. Ledger is per child, as announced BEFORE execution, not a global provider-spending grant.

Every child has20,000 nested MemoryRedis.run commands,100 forwarded mock fetches,120s,512MiB,256KiB output. Guards precede module evaluation; external fetch/socket APIs deny actual provider access. Types120s/1024MiB. Serial, zero subagents. Volumes: billingOLD61/22,HEAD65/22; cardOLD234/22,HEAD224/22 (nested Redis/forwarded mocks). No cap was hit or raised. The fixture's separate synthetic fallback-ledger commands are included in nested MemoryRedis counting. No real Redis/Lua, browser/AT, provider, production funding/global MR, complete cron HTTP or all author suites certified.

## Validation and scope

New linked recovery-marks-exact:14PASS. Strict ES2017/Bundler/noEmit types on both probes and two productive roots/imported graph:exit0. ESLint --max-warnings0 on two probes+runner:exit0. Complete JSON outputs are siblings. Npm setup used --ignore-scripts, lock unchanged; no account/key provisioning. Scanner/diff outputs are preserved alongside the final artifacts. No stale invalid full l6 attempt is relabeled GREEN; earlier caps/failures remain qualified in6719211131.

Only new two probes, runner/config/output JSONs and this report change. Author product/ref, source modules, authored tests, reservations, prices, limits, flags, accounts, terms and payment settings are untouched. No CI retry/cancel/queue/merge. This evidence supplement closes the NEW publication gap once its immutable remote commit/readback is confirmed; it does not remove the findings or convert the existing partial review into a clean approval.

C4-3100 ORIGINAL reread: MAIN VERDE/O CONGELAMENTO ACABOU (06Nov22:33). With #3217 closed, no additional literal announcement is required. Earlier S10:06 interpretation was incorrect and is superseded. Consolidated push/main/exact review/nine fresh-green conditions still apply to any future product PR. C2-1010 supplied the pointer; not an invented permission.
