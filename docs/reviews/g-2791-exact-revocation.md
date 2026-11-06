# Codex G — #2791 exact-head independent review

- Reviewed head: 7df9dbb1fbde6490ca0fc5a838565be158631c9c.
- Previous source: parent 8bb21d01614fc1b7830a0ae7e8f7c512ca98673f.
- Nominal first financial: C4-20261106-0820-TODOS-38. R2 is second. G makes no product/reservation/foreign-ref/CI/merge change.
- Review: https://github.com/solrenning-llc/marktmorgen/pull/2791#pullrequestreview-5797843491
- Entire 8-file diff read, 157 additions/24 deletions. Full surrounding refund loops and shared receipt/course authority code inspected.

## MEDIUM — unknown PayPal HGET envelope becomes a confirmed missing record

lib/paypal-sales.ts:735 destructures the answer for one HGET without checking its exact envelope. Lines 739–740 read the first slot null as a missing purchase and remove the order from the refund watch. [null,1] is an unknown response to ONE command, not a confirmed null.

The proof uses the author's real order creation/capture/handOverPayPal/ownership/refund fixture. It targets only the last standing refunded order; its previously refunded sibling has already been removed from the watch. Real importedFor and purchasesFor are then used. It does not inject a product deletion, synthesize the purchase, or manually add the target back to the watch for recovery.

Reproduction:
1. Complete and hand over two payments; refund the first, retaining the purchase on the second.
2. Refund the second. At its real imported-purchase HGET return [null,1] once, with the backing store unchanged.
3. The target disappears from the real watch; the grant still exists.
4. Restore transport. Advance Date.now by 3,601,000 ms, then run the actual watcher again, without re-adding the target.
5. importedFor still has 1; purchasesFor still lists Sourdough Guide; dropStart was not called.

Frozen proof: tests/g2791-paypal-record-envelope.proof.ts at 8c5c707a56b9319823b70f82d7cda14e03188ea2. The identical final bytes run on both parent and head:
- G_REPLY=extra: 62 checks / 2 causal failures on each.
- On head G_REPLY=control, empty and queued: each 62/62.
- This is an inherited residual in the reader this PR hardens, not a newly introduced regression.
- Validate repliesFor(await redisPipeline(...),1) before interpreting null; an unknown envelope keeps the watch for retry.

Runner: tests/g2781-run.mjs at 7756cb0339e3053f488e62fadf788d6106e038d6. Example: G_REPLY=extra node tests/g2781-run.mjs g2791-paypal-record-envelope.proof.ts .
The first draft normal-control assertion mistakenly expected the purchase to remain even after normal successful removal; it was corrected to expect 0 only in that normal control BEFORE freezing the proof. The two extra-envelope failure assertions were not relaxed. Earlier experimental output was superseded by the frozen proof output.

## Previous RED / current GREEN

The same FOUR final author tests were copied to a separate parent worktree, with parent lib unchanged:
- drop-enrollment-exact: 14 / 9 failures -> 14/14.
- gifts: 34 / 1 failure -> 34/34.
- preorders: 32 / 2 failures -> 32/32.
- paypal-sales: 67 / 3 failures -> 67/67.
Total GREEN 147. The author's courses-first changes fix these exact failures.

51 linked existing .test.ts files selected by direct imports of gifts, learn, paypal-sales, preorders, group-buy, paypal-delivery, purchase-email all passed: 45 custom-summary groups / 2,816 checks plus six node:test groups / 58 tests, exit 0, no failures or skips. Counts include the four focal tests and are not added again. Includes erasure-request-full (21/21). Does not claim the author's 63-file selection was reproduced.

Strict scoped TypeScript covering all four changed product files, new permanent helper test and G proof: exit 0.
ESLint all 8 changed files + G proof: 0 errors; 7 unused fixture warnings only in G's derivative proof.
check_public_data.py: 3,918 tracked files, 0 corrections.
git diff --check HEAD^ HEAD: exit 0.
No full application build/global CI, browser, real Redis/Stripe/PayPal, deployed checkout or production/margin certification.

## Integration with #2781

The immutable original 65557d01 course-ack proof (blob 807881d3346032b81412403ef560c75c0c22a539) was copied byte-for-byte:
- Exact #2791 head alone: 18 / 4 failures: its OLD group-buy deletes the imported marker before calling the throwing helper.
- Own isolated combination: exact #2781 d77a5788b369b7e217dc801710cbd740b9ae3094 + exact lib/learn.ts bytes from #2791: 18/18. This is an explicitly labelled combination, NOT the state of either individual PR.
- Exact #2781 alone previously 18 / 3 failures (known C4 helper receipt issue).

Therefore #2781 must enter BEFORE or TOGETHER with #2791, preserving R1's note. G's 5797666102 closes the group-buy ordering finding on d77; the helper residual belongs to C4. This PayPal-envelope finding is separate from that group's tested helper combination. No integration or foreign source is pushed by G.
