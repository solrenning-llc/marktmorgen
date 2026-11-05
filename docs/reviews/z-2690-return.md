# Nominal return on Z's two #2690 findings

Reviewed corrective head: `d7fd2f0eeb86497d74e36a5d6b3d544e9db35484`, stacked on #2685 at `4808934e0e7fcea4e4b1dba0325b8c0e449b9a70`. This follows the author's 20:17 nominal request. Channel reservation/expectation explanation: `21b922f1e2640ad28b49083eddd1172b4baed309`, published before writing the new evidence. Claude 4 retains the current second financial review and T the first; this return covers only Z's critical-write and cache-transfer vectors. It does not review or release the parent or their invite findings.

**NOT RELEASED: the critical-write MEDIUM remains open.** The cache-transfer vector is closed in the measured scope.

## Remaining MEDIUM: a same-length pipeline still confirms an unknown critical SET

`lib/catalog.ts:1089–1093` now rejects an outer response whose length differs from the number of commands. The original empty-array vector is fixed: the actual option POST returns HTTP500, the strict client confirmation rejects it, and the buyer still sees the old state as unconfirmed.

The same real three-command product pipeline consists of SET, DEL, HSET. Return `[null, 0, 0]` without applying that pipeline: the critical SET is unknown, while the two zero-count replies do not establish that SET succeeded. The new `repliesFor(..., slice.length)` accepts this exact length. The later owner CAS succeeds. Actual results:

- HTTP200 and strict `confirmsOptionWrite` true;
- persisted option still has no `offSale:true`;
- actual buyer `readListing`/`sellableOptions` still offers it;
- one injected unconfirmed product pipeline; zero Stripe requests.

This is the original critical-write finding with an additional reply shape, not a separate unrelated defect or a demonstrated real payment. The actual route, session guard, locks, store/catalog writers, client confirmation and buyer readers run; Redis transport and external network boundaries are synthetic. The fixture selects a product outside the first-page head.

Validate acknowledgement semantics for each command before certifying the critical publication, including exact `OK` for unconditional SET. Exact array length alone cannot certify an unknown critical write. Do not add unpriced retries/readbacks or globally alter another owner's shared decoder as a shortcut. The author owns this repair.

## Cache-transfer finding: closed for the demonstrated vector

The actual producer's 2,000-subscription JSON still occupies184,454 bytes. The corrected count route issues GETRANGE0..40000, transferring40,001 bytes in the ASCII fixture after the same one admitted studio unit. The favorable attributable budget remains148,320 bytes, unchanged from the original proof. No full cache GET or Stripe request occurs. The route returns HTTP200 with the option count null, not an invented zero. Small valid cache still produces the exact count. The proof also checks the requested range and keeps the original budget predicate.

Redis's inclusive range requires the extra sentinel byte to recognize overflow. This result is a bounded cache-response proof, not whole-page, whole-month or dollar-margin certification.

## Immutable and derived evidence

The original `tests/z2690-financial.proof.ts` is byte-identical blob `9ae6051463d4c252c824e2278d689e0d1b84c222`. It reports5pass/2fail on the corrective head: the two historical cache controls require the old GET and an exact count from a large cache. These expectations deliberately remain preserved. The original empty-ACK vector passes after the fix.

Before deriving a new proof, the channel explained that the new bounded read may legitimately return unknown for an oversized cache, and that the148,320-byte ceiling would remain unchanged. New `tests/z2690-return.proof.ts` includes that behavior and one same-length unknown SET vector. SAME eight cases on previously reviewedb162:4pass/4fail; corrective d7fd:7pass/1fail. This closes the cache and empty-ACK vectors, while retaining the medium semantic-ACK failure. A preliminary run against the older stacked parent acd15249 was exploratory and is not used for this comparison.

Run from the Z evidence branch:

```sh
node tests/z2690-run.mjs /path/to/d7fd-checkout z2690-return.proof.ts
```

## New head observed while publishing

The author moved to `978f48b03deb0190d2ecccd92f351d0cb24bb780`, parent `2c9bce6de1eb54c181c7bfd90f7c7961cf119b54`. Its delta changes only the move page, move words, move-members and move tests; catalog, membership-numbers, option route and store blobs are byte-identical to d7fd. The same eight-case derived proof was rerun on978f:7pass/1fail, with the same40,001-byte bounded read and false200 on `[null,0,0]`. This does not review the invite delta or update the d7fd-only linked/type/registry results into a general978f certification. The posted focal finding can therefore anchor978f while preserving the separate parent reviewers.

## Checks and limits

Corrective author/linked tests: option-sale-toggle62, membership-numbers18, option-off-sale22, option-member-count27, plan-options24, price-options27 and cost-registry24 all pass (204 checks). Data-registry is **6/7**, failing on the parent's new unregistered `nl:mv:open:@lib/move-members.ts` family. This was reported separately to C2/T/C4; it is outside this focal review, and the linked suite is not claimed wholly green. An initial batch misspelled `option-member-count.test.ts` as `option-members.test.ts`; its bundler failure was corrected by running the actual file, without changing tests.

Scoped TypeScript of the corrective three product boundaries and of the new evidence, focused lint and diff-check pass; the final public-data scan and tree equality are recorded in the posted review. No author source, branch, reservation or CI was changed. No native Redis, browser, real provider/payment, global build or hosted CI was certified. Current C4/T financial returns, parent findings and all nine exact-head aggregate checks remain mandatory.
