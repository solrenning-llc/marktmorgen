# Shared-numbers counter admission: bounded main-only evidence

Codex S, proof-only reservation2218b98ef6e6228605e95a0dfe688210bdb75a38, read back exact BEFORE fixture/code. Subject main adf49191751dd0fa28d523d673dc947eb3bdff3f; lib/numbers-links.ts:147-151. No product patch, new limit, flag, account, provider or public page edit.

**One MEDIUM PROPOSED, conditional exact-reply/admission finding, for Claude1 classification and assignment.** countOpen destructures the first pipeline member and returns Number(n)<=OPENS_PER_DAY. A null, boolean or impossible-zero count is accepted as0 and authorizes an opening after the real counter has reached301. The healthy path confirms300 openings and refuses301; the unknown-result path should not override that refusal. This is not a proposed increase/decrease of the existing300 maximum.

Actual consumer app/numbers/[id]/page.tsx:80-91 first checks countOpen, then takePublicRequest, then readVerified. The page path was read only. A failure of this local daily guard does NOT establish a bypass of the independent funded public-request guard, unauthorized/passwordless access, a provider call, an actual monetary loss or an incorrect displayed financial total. No full Next HTTP/cookie/store flow was executed. The helper's admission result and actual Redis-model effect are demonstrated; downstream work is source inference only.

## Reproducible proof

New tests/s-numbers-link-counter.proof.ts calls real countOpen with real MemoryRedis via the official redis-stub. The healthy producer first reaches300. For each fault it restores exactly that healthy reached count, executes the REAL INCR+EXPIRE pipeline, and only then substitutes its reply. It reads back the actual committed counter301 and confirms interception. It never forges the stored counter as a claimed application effect or changes production source. The guard ledger never resets between cases.

Final25checks/7FAIL,18PASS; exit1 is intentional RED, no exception/cap failure. Four healthy controls include production LINK_ID validation, first opening,300 total, refusal301. Seven faults: [null,1], ["1",1], [false,1], [0,1], [1], [1,0], [1,1,1]. Each expects false, gets true; after each, actual GET is301 and the original pipeline was reached. Null/boolean/impossible-zero specifically demonstrate unknown count coercion at an actually over-cap state. Other cases additionally replace the count with1: they demonstrate rejection missing for malformed cardinality/expiry ACK/type; do NOT claim they are natural truncation preserving an original301 response. All are explicit transport-reply fault injections, not a claim that Redis normally emits them.

Initial exploratory fixture had a21-character ID and24checks/7FAIL. That established only helper behavior, not a valid-page fixture. It is preserved IN FULL in initial-fixture.json. The final fixture changes only the ID to a valid20characters and ADDS production LINK_ID control; no business oracle was weakened. Final25checks are not summed with exploratory24 as distinct coverage.

```
node proofs/s/numbers-link-counter/run.mjs tests/s-numbers-link-counter.proof.ts
```

The complete raw stdout/stderr/status/head are in the JSON output, not a reconstructed summary. Runner uses official aliases/environment, no old-module overlays. Predeclared before child:20k nested MemoryRedis.run/100 forwarded mock fetches/120s512MiB256KiB; types120s1024. Network fetch/socket deny before module graph, serial0agents. Actual630 nested commands/0HTTP, no cap hit or raised, no actual provider. Existing own dependencies were used read-only; no installation or provider credentials.

Strict ES2017/Bundler/noEmit types on helper/probe and imports:exit0. Lint probe/runner --max-warnings0:exit0. No GREEN of the regression asserted and no product fix requested as reviewed. Scanner/diff outputs accompany final evidence. No native Redis/Lua/browser/AT/Next route/full-suite/production funding/global MR or CI nine checks certified. No linked full product suite rerun for a source-unchanged proof-only change.

Rule30 scope: exact-pattern scan found lib/membership-manage.ts:101 (Number(count)<=limit), an UNPROVED follow-up without new grade or execution, plus this numbers-links.ts:150; parseLinks/linkStore shape issues in the same module remain unproved follow-ups, not additional ranked findings. report-response.ts triage was discarded: it handles abuse notices, not creator business reports. No claim of a whole-repository audit or globally exhausted work.

Claude1: classify/assign the demonstrated countOpen cause; author must preserve the same false-on-unknown invariant with durable RED before a fix. Any UI change must distinguish unknown from known daily exhaustion, retain paid admission and existing limits, and respect ownership. No correction or branch/PR of another agent was edited. This branch contains ONLY new owned evidence artifacts, not a product implementation or a new reservation-document PR.
