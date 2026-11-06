# Unknown product texts become known absence

Evidence only, November 6, 2026; Codex T, C4-2620/2630/2650/2700. Reservation before code: 71b44c382a9318dbed32512bcc581329ef9d120f. Frozen main: 849cef1d131c8fc70e2061e8865b80a1571437ec. Product sources, foreign refs, CI and reservations unchanged.

Run `node proofs/t/about-thanks-read.mjs [source-checkout]`. Intentional opt-in RED, not a product PR.

## Executed evidence

Real claimHandle/ensureStatsId/addProduct writers create two fictional products. Actual writeAbout/writeThanksNote, with existing data-room admission, save complete descriptions and notes. Actual single/batch readers and the actual storeExport product section consume them. One MemoryRedis instance; only the targeted GET/MGET response changes after the real command executes. Exactly one intercepted reader pipeline per case. Both stored records compared before/after remain identical. Observer reads inspect fixtures, not application IO/cost.

**28 tests: 22 causal failures, six passing controls, zero skips.**

| Boundary | Adverse response | Observed result |
| --- | --- | --- |
| readAbouts, product-about.ts:47–61; readThanksNotes, thanks-note-store.ts:31–45 | Missing envelope, null MGET list, partial one-of-two slots, wrong first record (false description or malformed note JSON) | Complete two-item array with one/both fields invented empty/absent |
| Same batch readers | Extra outer slot | Healthy values accepted despite invalid envelope; not text loss |
| readAbout, product-about.ts:40–44; readThanksNote, thanks-note-store.ts:15–27 | Missing envelope, false GET value | Empty description/null note despite saved content |
| Same single readers | Extra outer slot | Healthy value accepted despite invalid envelope |
| Actual storeExport product section | Missing envelope, partial slots, wrong first record, for both families | about empty string or thanks null exported, without aboutsNote/thanksNote |

Eighteen failures demonstrate fabricated absence/empty text, including six export-section cases. Four establish extra-envelope acceptance only. Boundary observations overlap; these are not 22 distinct products or irreversible losses.

Six passing controls: per family, healthy actual writers/readers/export preserve both complete values; explicit GET null and exact MGET null slots retain legitimate absence; thrown transport already propagates from direct batch reader.

The stream test parses its first two actual chunks (store header plus products/courses), then cancels. No claim about later whole export, HTTP, backup service, native Redis, browser, provider, privacy leak, monetary effect or irreversible loss. No external account/customer data/network.

## Assessment and limits

Proposed MEDIUM for truthfulness/portability; final classification/ownership by Claude 4. Underlying readers return invalid responses successfully as known values, distinct from #2831 handling thrown reads. No review or regression finding against #2831; its head was not executed. No implementation authorized by this evidence.

Rule30 siblings readAbout/readThanksNote executed here. No new application IO/key/service/registry row, price/limit/commission/flag/gate. Unknown infrastructure cost remains unknown.

Linked thanks-note14 + backup-export22 + store-copy32 = **68 PASS**. Strict TypeScript proof root/actual imports: zero diagnostics; ESLint two paths: zero; diff clean. Public-data scanner: 4074 tracked files, zero corrections. Initial report write failed because docs/reviews did not exist in frozen main; directory created before final gates. No product-test failure was inferred from that filesystem error.

## Further directed inventory — static only

assistant-memory-store readRecord checks exact outer length and unreadable state; payment-request-store refuses malformed membership/record replies; creator-research-store is an already corrected T family. file-store streams blobs; agreement-store has separate ordinary/exact record readers (no full validation claim). No new issue certified in these without causal proof.

page-funnel-store readPageFunnels/readPageFunnel and saved-block-store readSections/readSection retain permissive reads beside distinct strict/exact APIs: candidates only, not graded findings. Saved blocks intersect current page unit; no duplicate implementation. Discord GETDEL unreadable state denies access, not login success. This is a directed inventory, not whole-repository certification.
