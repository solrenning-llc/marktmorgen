# Independent review #3169: unknown counter formats still authorize work

Codex Z, 8 November 2026. Subject **cbdd5f458ed4e402ecb3c5b78ddaffa2d78a8ab0**, baseline d64aa0e7b01dd7facfe52ddd937f59c6a116ec95, author RED372af8b70. Complete17-file PR delta read:11production paths,5test files,1fixture. Claim6716913571 before source; channelRES9b3c1a859ff9e6f450fbea1f50f8935fb2765a1d/blobbbd46c750291114438e7c4f0c054e8cd27f078cc FULL5129095 EXACT before new proofs/execution. Author source/ref/CI/queue untouched.

## Verdict

**NOT CLEAN: one proposed inherited MEDIUM (rule24), not a newly introduced regression.** lib/store-allowance.ts:250–258, reached by allowanceUsedExact at279, still coerces noncanonical string replies with Number(raw). Empty string, whitespace, hexadecimal zero, decimal zero and exponent zero become known0 rather than unknown. The new helper calls this reader; so claiming it is exact does not close the whole unknown-counter boundary.

Independent real-reader11cases:6controlsPASS/5FAIL. For each of "", " ", "0x0", "0.0", "0e4", BOTH allowancesUsedStrict and allowanceUsedExact report0. Each pair attempts2synthetic GETcommands; this receipt interception replaces the transport response, it does not fabricate a production caller. Controls confirmednull/"0"=>0, "25"/25=>25, "many"/"-1"=>unknown PASS.

Independent caller proof uses REAL remindFromConsent, emailRoom, model request and sender paths with the author's explicitly simulated Redis/deployment/Stripe/model/mail fixtures. Only the email-counter GET reply is replaced; actual durable counters and downstream admissions are otherwise untouched. In each of "", " " and "0x0", the result is **["sent",1mail,1model]**, where unknown must give["failed",0,0]. The positive controls canonical"0" and confirmednull send1mail/1model; "many" is correctly refused on head. Ten checks:7PASS/3FAIL on head,6PASS/4FAIL with ONLY11old production modules from d64aa in the final graph. SAME final proof/oracles on both sides. Thus the word-vector cause is fixed and the three permissive formats remain; not four separate defects/incidents.

The observed model JSON body is1339bytes per bad vector; the synthetic captured mail-view JSON is965bytes. The latter excludes the provider's full request envelope/headers/TLS, and neither is a worst-case cap or native billing amount. The proof does NOT establish uncharged work, exceeding a real plan, a global financial loss, real mail delivery or actual provider spend: downstream paid pool/email admission remains exercised with synthetic funded fixtures. It establishes that the promised refusal BEFORE model/send still does not happen for an unknown counter read. No price, limit or flag was changed/opened to obtain it.

R2/C1: reproduce/classify this inherited defect before an author fix. Author can correct the shared decoder with permanent REDs and request a new exact-head focal; reviewer does not edit the foreign source. Keep confirmed null as absent0, canonical0 and healthy counts; reject unexpected formats instead of broad Number coercion. No blanket approval/pode entrar or nine-check certification.

## What is corrected and what was tested

- The author's unchanged RED files were executed in the final dependency graph, replacing ONLY the11production modules with baseline versions for OLD. The5test blobs are BYTE-ID between RED372af8b70 and final: allowance-used-unknown11FAIL->11PASS; assistant-reminder52/4FAIL->52PASS; group-buy65/4FAIL->65PASS; store-copy33/5FAIL->33PASS; path-plan10/1FAIL->10PASS. These give171passing checks on head; the new helper's absence explains the11RED failures, not11independent production bugs.
- Related path-weekly-summary-page15, plan-cost-registry26, store-data-registry7 and platform-us-english42 PASS:90related checks, **261ordinary PASS total**. Not the author's claimed74-file run.
- store-allowance13 is **INCONCLUSIVE under the pre-admitted100mockHTTP limit**:12casesPASS/1FAIL at mock101; fatal guard flags overflow BEFORE dispatch. This is a review-budget failure, not a product finding or a full-suite GREEN. No ceiling was raised and that full suite was not replayed.
- Scoped actual repo ES2017/strict/Bundler19roots1367sources (all17changed paths+2own proofs):0diagnostics. Final type run after byte diagnostics/import cleanup retained separately. Final lint21paths0errors/0warnings (17author+2proof+2own runners). Initial copied-fixture unused imports and prefer-const failure retained in initial lint/raw evidence, not called product RED.
- Fixture derivation is explicit/separate: selected setup and fetch stand-ins from tests/assistant-reminder.test.ts plus its left-checkout fixture; removed unrelated branches/assertions from the newly authored focused probe, not from the author's permanent test. Four setup assertions plus six boundary cases yield10checks. Unused imports/helper/assignments were subsequently cleaned without changing ANY is() assertion source;5static call sites verified BYTE-ID (one is the6-case loop). Product setup calls, including all3products, retained. Added only diagnostic byte output; final SAME proof was rerun on OLD/HEAD, with initial logs/source preserved.
- Per child20,000nestedMemoryRedis.run/100mockHTTP/120s512MiB256KiB, types1024MiB120s. Guard before dispatch, real fetch/socket denied before graph. Max nonoverflow3010nestedrun/41mock in OLD; final caller346run/21mock. The separate store-allowance overflow reaches101counted attempts and dispatches at most100. No native Redis/Lua, live Upstash/Stripe/AI/SES/mail, browser/AT/client-build/fullTSC/globalMR/CI/merge certification.

## Scope and rule30

The UI propagation to agreements/requests/Path is coherent: unknown is rendered as text, Path no longer offers plans from an unknown count. Review covers source/helper tests, not live rendering or screen-reader behavior. Original other costs/gates/rights unchanged. The legacy allowanceUsed wrapper intentionally remains unknown=>0 for app/studio/page.tsx; author disclosed it and C4/C6 have that follow-up. It is not declared fixed by this PR. Related allowancesUsedStrict callers are listed in callers.txt; the same permissive decoder is shared, but no new severity is asserted for each caller. Existing reminder GET/TTL-before-admission proof27bb340a remains a SEPARATE pending classification; this PR's emailRoom change neither fixes nor re-proves that earlier issue.

No new Redis command/key/retention/registry family in the corrective delta; same one GET per count. New helper also reads when emailRoom's limit is invalid whereas the old short-circuit could skip it; that paid command is not zero, and generic funding/global worst-month coverage is not certified by this review. Source-only observation; no second unmeasured cost severity invented.

## Reproduce

Copy own probes/directory into exact cbdd checkout with dependencies:

```sh
node docs/reviews/z-3169-allowance-count/runner.mjs z-3169-count-shape.proof.ts z-3169-reminder-count.proof.ts
Z_OLD=d64aa0e7b01dd7facfe52ddd937f59c6a116ec95 node docs/reviews/z-3169-allowance-count/runner.mjs z-3169-reminder-count.proof.ts
node docs/reviews/z-3169-allowance-count/types.mjs
```

Both proof invocations deliberately exit1. All raw outcomes/guards, fixture cleanup and final checks are preserved; trailing whitespace in display logs is normalized only with reversible exact raw strings+SHA256. No supplier/account/contact/price/visible-limit/commission/gate/flag/PII action or subagent. Own product unit count remains3including reminder proof.

C1-0051/CODEX24 received while this already-claimed small review was active. Next priorities: own2741 main integration (known FAQ390/root shared3094 still OPENe051, not the affiliate-leads failure); explicit second financial3072 on currentbe6355, then nominal3060 on8854f262. The new explicit second assignment supersedes earlier do-not-duplicate metadata-only reconciliation. No code/ref/test/claim3072/3060 yet; G's first3072 review must be credited. C1 decides unresolved own/R2 dispositions; no blind rerun of consumed jobs or knowingly condemned CI.
