# H2 independent review — #3049

Reviewed exact product `8ca43fda418f4656a46e9cdecb49ff35d3919fba`.
Requested by Claude6/07Nov03h11; announced BEFORE source/diff/tests in
PR6703229237 and full-prefix channel commit0c2927d0a9c06ae266702b2f88d45e530005f57f.
The first channel CAS409 made no write; the successful attempt followed a
full immutable blob reread after more than120seconds, and readback was exact.

No HIGH, MEDIUM or LOW finding demonstrated in this diff. Content review
permits proceeding only with applicable final reviews/nine exact-head gates
and C4's literal FILA LIGADA; no direct merge or automatic release is granted.

Both routes now test the existing typed setStripeAccount result before
claiming ready/pending. An unsuccessful write produces the existing error
redirect, as connect already does. The original exception handling, session,
payments permission, POST origin guard and return's origin exception remain.
Read all three changed files, creatorFrom/studioAccess, the store lock/save
and setter, readAccount/transport, the studio notice and the other production
callers (connect and demo-seed). No added provider call, setter, financial
term, admission change, account configuration or flag was introduced.

## Executed evidence

| Entry | Result | Dispatched synthetic pipeline commands | Mock HTTP |
| --- | --- | ---: | ---: |
| SAME final author test against durable pre-fix source4a216e5171d74d3e80c5fd317a6139378ddfc0f6 | 77 checks/20 causal failures; healthy controls preserved | 360 | 24 |
| Author test against final8ca43 | 77/77 | 360 | 24 |
| Independent actual route/store/session proof | 27/27 | 190 | 12 |
| Linked connect-configuration | 218/218 | 0 | 42 |

Final candidate checks total322. RED is not added to that total. The final
test (including the shorter synthetic account ID) was unchanged between the
RED and GREEN source selections. Product source is pinned by git show;
MemoryRedis/session/store/NextRequest/routes are real reachable code, Stripe
responses are strictly synthetic and no request is forwarded externally.
Independent controls cover signed-out, no account, unconfigured platform,
foreign POST Origin, healthy active/inactive transitions, provider503 and a
thrown persistence read. Expected error logs are synthetic failure controls.
The linked test protects the existing country/configuration/fee/loss payload;
it is not current eligibility verification or a promise of no platform loss.

The initial linked-test observer started after main's first synchronous
provider call and counted41; its own42 single-call assertions passed. The
observer now installs immediately BEFORE main. Only that incompletely counted
linked run was repeated:218/218, counter42. Preliminary41 is not a qualified
HTTP total. Earlier author/independent counters were already installed before
their provider calls because fixture setup yielded first. No author assertion,
product code, timeout or limit was changed for this instrumentation correction.

Four TypeScript roots/779 imported sources, strict zero root diagnostics
(not global tsc/build). ESLint all five changed/evidence code paths: zero errors/warnings with
max-warnings0. Official scanner:4,154 tracked files/0 corrections. Native
diff-check clean. No browser/screen-reader/native Redis/live provider/account
or end-to-end financial admission/cost certification. The existing broad
stripe=error wording and provider parser are unchanged; this review certifies
the narrow result check, not all possible lost-acknowledgement semantics.

## Reproduce

```sh
timeout 120s node --max-old-space-size=512 proofs/h2/3049-stripe-write-run.mjs
```

Optional filename: stripe-account-written.test.ts or connect-configuration.test.ts.
H2_REVIEW_REF accepts an immutable40-character SHA for the selected product.
Each process bounds20,000 dispatched synthetic pipeline commands,50mock HTTP,
110s child timeout/120s outer timeout,512MiB Node heap and256KiB output.
The TypeScript process used1GiB. No remote author ref, CI or product file edited.
