# Reminder admission ordering: bounded proof, classification pending

7 November 2026, Fortaleza. Source snapshot `ed94ad5000f1e2e8ecb9faac5e656b0c9bcc00e5`; `lib/assistant-reminder.ts` blob `01d0a7dd3405a8c07490298ab3b2167b9c8a5cb9`.

**Proposed conditional MEDIUM for C1/R2 disposition, not a certified financial loss.** `remindFromConsent` issues GET and TTL at line292 before the public-read admission at297. A missing consent exits at294 without asking admission. The comment296 says its reads are counted before any is made; `ASSIST_REMIND_READ` (tests/plan-cost-registry.ts) expressly includes consent/store reads in the four public-request units. The order does not match that comment.

The proof runs the REAL compiled caller and its pure local checks. Redis, quota, configuration, key function and Stripe boundaries are explicit stand-ins; unrelated imported functions throw if reached. The admission stand-in separately models refusal before a counter is committed, an unknown admission, and healthy admission. It does **not** execute real `takePublicRequest`, funding, allowance windows, cron, checkout or provider code. Therefore zero units in that stand-in is NOT a measured real invoice or proof that all refused requests are uncounted. The actual traffic implementation can leave over-limit attempts counted. C1/R2 must confirm whether earlier checkout/admission or company funding already pays these preliminary reads before deciding on a source fix.

## Final observations, unchanged four oracles

| Scenario | Redis commands | Public units in stand-in | Stripe stand-in | Order / result |
| --- | ---: | ---: | ---: | --- |
| Refusal before count | 2 | 0 | 0 | GET+TTL, then admit4; skip |
| Unknown admission | 2 | 0 | 0 | GET+TTL, then admit4; error propagates |
| Missing consent | 2 | 0 | 0 | GET+TTL; skip without admission |
| Healthy control | 2 | 4 | 1 | GET+TTL, admit4, completed checkout read; skip |

The first three oracles require no preliminary command without admission; each remains RED. The healthy control passes. Final worker: **4 checks, 3 fail, 1 passes**, 8 synthetic commands and 3 admission calls; zero external calls. Per invocation, the serialized command-array payload is103 bytes. Reply-value JSON is142 bytes with consent or9 bytes without it. These are fixture-specific bytes, excluding REST envelopes, headers, TLS and deployment overhead, not maxima. The consent includes only synthetic example.invalid data. No dollars/global margin are asserted.

The existing guards remain material: at most50 accepted consents/store/day, queue read LIMIT100, consent retention3days, queue removal, cron lock and22-second time slice. They are bounds, not proof that a refused public-read admission has paid for these two commands. Do not call this an unbounded loop or a new provider send. The public counter itself is not among the two observed caller commands.

## Reproduction and boundaries

```
node proofs/z-reminder-read-admission.mjs
```

Expected exit1, final JSON above. The parent reads the subject TS, generates explicit dependency boundaries and uses esbuild; child sockets and fetch are denied BEFORE loading the graph. Before dispatch:20 total synthetic commands and10 admissions,120s/512MiB/128KiB per child, no provider. Final worker uses8/3. Across BOTH workers executed in this experiment,16/6, within admission. No oracles were weakened.

Two harness failures are retained separately: build-attempt.log is an import-parser error before execution (the regex crossed the node:crypto import); boundary-attempt.log is a missing constant stand-in that also broke the healthy control (4fails, NOT product RED). The parser was corrected, the request-unit constant is now verified against its actual source value4, and its boundary supplies4. The final run alone is the qualified product-order observation. Neither exploratory log is called a successful product test.

No TypeScript product changed. `node --check`, evidence diff-check and the public-data scanner are separate receipts; no full type/build/UI/Redis-native/CI proof is claimed. No financial verdict about provider costs follows from an isolated boundary test.

Read-only rule30 follow-up checked the two related paths next-offer and checkout-ask: next-offer has kept-data reads/writes and a later public-read gate, checkout-ask has queue reads/removal. They require caller/cost attribution before being called the same defect; no additional finding, proof, severity or ownership is assigned here.

Ownership: C5/3095 erasure work and N2608 email admission are untouched. This branch changes only its own proof/log/report files, no product or reservations file and no PR. RES95835eb3655c7a7a3ec6a6cc5240b0d22b255aec/blob5d7665d569c0c6ea210cc04e451d1dd999c43b67 preceded new code/tests; immutable FULL readback exact. Older RES2044 attempts failed409 and were never delivered. Own2741/2819 heads, previous REDs/WIPs and consumed CI retries are unchanged. Current MV main-red hold prohibits product PR pushes/merges; no such action was taken.
