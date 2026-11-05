# Codex Z: second financial review of #2690

Exact head: `b162aa53302b5cbcc583f4f5439993523b8a308d`.
Stacked parent: #2685 at `acd1524934308ca25f88686663f56ae9049df5a5`.

**WITH FINDINGS — DO NOT MERGE.** This is the second requested financial examination, not a qualifying approval. T's first review and closure of the count-shape defect remain separate. The nine-file unit-2 diff was read in full. The parent's approval, B2/store reservation exception and final exact-head CI are not waived.

## Medium: successful off-sale confirmation after an unknown critical write

New boundary: `lib/store.ts:4409–4420`, `app/api/store/option/route.ts:89–96,125`.
Inherited cause exercised by the new boundary: `lib/catalog.ts:1084–1087` ignores the product-write pipeline response; the later owner-record CAS alone determines success.

The proof uses the actual option POST, actual session/authorization, store locking, product persistence, buyer listing reader, `sellableOptions` and strict client confirmation helper. The only injected failure is the three-command product-record pipeline: none of those commands apply and its reply is `[]`. The subsequent owner-record CAS applies normally. The fixture deliberately selects a product outside the store's first-page head so that the buyer reader obtains the product record, not a replacement card.

Observed: one dropped product pipeline; HTTP 200 with `{ok:true}`; `confirmsOptionWrite` returns true; the persisted option still has no `offSale:true`; the actual buyer listing still offers that option. Stripe calls: zero. This demonstrates a false completed-write confirmation and an unchanged offered price, not a real checkout or payment.

Do not confirm success based only on the later store-record write. The critical product update needs confirmed, owner-bound evidence and consistent publication; an unknown result must remain unconfirmed. Coordinate changes beyond the append-only store exception with the owner. No unpriced retry or readback is authorized by this review.

## Medium: the new count action reads more cached data than its admitted transfer budget

New boundary: `app/api/store/option/route.ts:63–69`; cache GET at `lib/membership-numbers.ts:656–660`.

The actual `numbersFrom` producer creates a complete 2,000-subscription cache, within the existing 20-by-100 subscription scan ceiling and documented 512 KB cache room. The target product/option has a confirmed count of one. The actual route returns 200 with that count and no Stripe call.

Measured: **184,454 raw cache bytes**, 9 route commands, **one studio unit admitted before the cache GET**, no preceding size measurement or extra charge. The raw cache alone is used for this comparison; protocol escaping and other reads only add work.

The proof grants the route the *entire* proportional kept-readings allocation as well as its base transfer budget:

- `PAGE_INCLUDED_BYTES`: 50,000 bytes per studio request.
- `KEPT_READINGS_SHAPE.dbBytes`: `3 * 131072 + 64 = 393280` bytes per four-unit studio page.
- Most favorable attributable total: `50000 + 393280 / 4 = 148320` bytes for its one admitted unit.
- The cache alone exceeds that total by **36,134 bytes**.

An initial 50,000-only expectation was incomplete. Before changing it, channel commit `f0214e055803dcdab6ab3a8f4e7b5b4a671c93fc` recorded why the extra 98,320 bytes must be included. The final, more generous predicate still fails. Separately admitted cold/daily readings are not spare capacity at the owner's full-rights worst case. This is a missing bound/attributable read-budget finding, not a calculation of dollar cost or a claim that a particular customer has negative profit.

Bound or size-and-fund the cached read before transferring it, preserve unknown when it cannot be funded, and add the exact new caller/evidence to the cost/data registries. Merely promising not to call Stripe does not bound the Redis response.

## Durable evidence and reproduction

- `tests/z2690-financial.proof.ts`: seven cases, **five positive controls and two causal failures** on this exact head. Actual route/auth/session, actual producer, store/catalog and client readers; MemoryRedis and forbidden-provider transport boundary.
- `tests/review-t2690-count-evidence.proof.ts`: T's original proof, byte-identical blob `17c7cdac4462972ebe8b31bee042928e888f8755`. On the old count implementation: TAP8 tests/3 pass/5 fail; exact final head: TAP8/8. No reviewer assertion changed.

Run `node tests/z2690-run.mjs` in the evidence checkout. An optional first argument selects another product checkout; optional filenames select evidence. Prefix a filename with `product:` to run that checkout's original test file instead of the evidence copy, for example:

```sh
node tests/z2690-run.mjs /path/to/red-a product:option-sale-toggle.test.ts
node tests/z2690-run.mjs /path/to/red-b product:option-sale-toggle.test.ts
node tests/z2690-run.mjs /path/to/red-c product:option-member-count.test.ts
node tests/z2690-run.mjs /path/to/old-count review-t2690-count-evidence.proof.ts
```

All review-only cases use `.proof.ts`, excluded from default test discovery. The expected two failing cases are evidence, not a passing product suite.

## Verification and limits

Valid independent historical reproductions: `9fcce8f1` =36 checks/12 failures; `39e98b25` =40/2; `26ccf206` =nine failing assertions followed by the malformed-list TypeError. Exact final author/linked groups:40+27+115+22+10+86+17+24+42=383 passing. The unchanged T proof adds TAP8/8; the new financial proof adds five passing controls and two failures.

An initial parallel attempt accidentally reused a scratch bundle path across product roots. Those outputs were discarded. The scratch launcher was corrected to create a unique temporary directory; all counts above were then reproduced with isolated outputs. The four common linked groups in the two separate Z product branches were also rechecked with the isolated launcher:101/101 in each, with no product/test/assertion changes.

Scoped strict TypeScript including the six changed product boundaries, two author tests and both evidence files: zero diagnostics. Directed ESLint: zero errors and two pre-existing unused-import warnings in `lib/store.ts`. Explicit runner syntax and byte identity of T's proof passed. Public-data scanner and final tree/diff results are recorded with the evidence commit.

No browser, assistive technology, native Redis, supplier, actual charge, global build/TSC or author-hosted CI was exercised. The existing R1 text/migration notes and stacked-parent dependency remain tracked separately. No author product, branch, reservation or CI was edited.
