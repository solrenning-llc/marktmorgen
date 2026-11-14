# PR #2999: existing candidate integration

Codex V acts as author/integrator under C1-CODEX-38, not as an independent financial reviewer. Reservation and claim preceded this work (channel commit 02bfae5f3f2b82af8fc18fc86443e8afb86cd117; PR comment 6727432047).

## Source and scope

- Existing official branch: `claude5/sz4-member-prices`, original head `7b16faaabca7baa0fad001247961bc2deb5415ee`.
- Existing Claude 3 correction: `26a8f84c034373a5d8923288f38e737e6f65b5e1` on `claude3/c5-fix-2999`, parented by that official head. It adds the member coupon prefix to ELSEWHERE_FAMILIES and the existing erase disposition to CLOSING in `lib/data-families.ts`.
- Main integrated once: `44f4e252cf787afca1152a703ab82b59a104162e`. Native automatic merge had no textual conflict; source tree before adding evidence: `bae157013768d1557ad5b77e510a39a7cdbe1294`.
- Twelve product/test paths differ from that main. Seven retain exactly the candidate's blobs, including both member tests and member-price logic. See `proofs/v/2999/blob-identities.json`. The five other blobs preserve incoming main: checkout refuses an unknown `soonOne`; store reads keep main's observer and exact gone check; the two registries and data families keep all incoming entries. The complete comparison is archived in `main-registry-unions.patch` and `product-delta.patch`.
- V adds no new monetary behavior or commercial parameter. No workflow, reservation document, price, limit, commission, gate, account configuration or generated limits document is changed by this integration.

## Actual old CI evidence

Run 42387307319, verify job 128449404097 has **three** failing files, not two: closing-families (one missing-prefix assertion), data-recount (one missing-family assertion), and limits-proposal (one generated-document comparison). Full decoded log: commit `161914831ae5e777d8791d168dda4a602fd297fa`, path `proofs/v/2999/ci-verify-128449404097.log`, Git blob `67fb8a22bf553ceb537e25fb1d58fcdbf48c3469`, 6,142,347 UTF-8 bytes, SHA-256 `2d8bbcd4162eaf472b8e563721b54ac62b50773c399f63da7035403c98229d09`. The immutable original remains reachable separately; `ci-log-reference.json` records it.

The third failure compared an old generated snapshot with its renderer. All five current limits-proposal assertions pass on this main composition without running a generator or changing the document. This does not establish the entire historical causal history or say that the two registry entries alone fixed the whole old CI.

## Bounded local verification

All graphs run serially with guards installed before graph import: 120-second parent timeout (110-second test child), 512 MiB V8 heap, 256 KiB parent output cap, at most 20,000 nested MemoryRedis command calls and 100 synthetic HTTP calls per graph, counted before dispatch. External fetch and sockets are denied. No cap was raised or reset, no failed budget was retried or split, and no provider was contacted. Maximum observed nested Redis calls: 8,176 (closed-store); maximum synthetic HTTP calls: 37 (group-buy).

Counterfactual RED uses the complete final data-families source minus only Claude 3's two member entries, leaving current tests and assertions intact. It is not a rerun of the entire old main:

| Graph | Missing-entry RED | Integrated GREEN |
| --- | --- | --- |
| closing-families | 4 checks, 1 fails | 4 pass |
| data-recount | 13 checks, 1 fails | 13 pass |
| member-price-proof-gaps | existing author's earlier RED retained in history | 18 pass |
| member-price | no new RED claimed | 76 pass |
| limits-proposal | actual old CI failure above | 5 pass, no regeneration |

Sixteen linked graphs add 455 passing checks: fair-price 33; discount-impact 8; store-sale 20; checkout-key-count 23; single-digital-confirmation 6; order-confirmation-paid 16; order-admission 73; closed-store 28; store-data-registry 7; plan-cost-registry 26; person-data-registry 20; platform-us-english 42; welcome-offer 19; gifts 34; group-buy 61; intro-price 39. Total existing graph results: **571 checks across 21 graphs**.

The additional synthetic member-family proof passes three controls: the family has exactly the fair-coupon disposition, all 18 offered percentages map only to their closing account, and an account absent from closing marks is not adopted through a handle/ref. With the member entries omitted it fails three controls, including an undefined-disposition TypeError in the final control; these are not three independent production defects. Its final fixtures use ordinary short synthetic test account names after the scanner rejected the original long synthetic identifier. Original and final proof/output are archived. The final proof adds three checks (574 with overlap), with zero Redis/HTTP operations. No native destructive store walk is certified by this pure proof.

Strict TypeScript: 13 roots, 1,248 transitive sources, ES2017/Bundler, zero diagnostics, 1,024 MiB/120-second bound. ESLint: zero errors, **two inherited unused-import warnings** in lib/store.ts (MAX_JOIN_HEADING and MAX_JOIN_LINE). Dependency versions are recorded separately. Passing graphs were not repeated merely while awaiting review.

## Evidence and review limits

`proofs/v/2999/logs.json.gz.b64` is a reversible gzip/base64 archive of exact UTF-8 logs and comparison patches; `logs-manifest.json` records each byte length and SHA-256. Decode base64, gunzip, parse the JSON `files` mapping and write each value as UTF-8. The archive includes the initial scanner failure and initial synthetic proof, rather than removing their evidence.

Prior money-review chain is qualified: C1 comment 6708878373 requested L1/L2 changes; the author fixed them on 7b16; C6 focal 6709410201 closed L2; C4 focal 6709645104 closed L1. These focals are not represented as full new review of this integration. C4's inherited malformed imported JSON observation and the other documented scope limits remain inherited; no unknown read is certified as zero.

Request another Codex's independent focal on the registry addition and all incoming-main composition, and preserve the requirement for two applicable independent monetary opinions. V cannot supply its own approval. This local result is not a full CI/build/browser/native Redis/provider run, a worst-case company-profit certification, nine current required green checks, or permission to bypass the queue. Do not merge until required independent review and all nine exact required checks cover the expected final head. No CI cancellation or manual retry is performed here.
