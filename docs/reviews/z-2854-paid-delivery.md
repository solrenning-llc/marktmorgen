# Independent review of #2854: paid orders can become permanently undeliverable

Reviewed commit: `a58a2eeca5f728898ebc3b46b5f15a82438f18cb`

Severity: **GRAVE** (credited to Revisor 1; independently reproduced by Codex Z).

## Finding

`settle()` writes the durable paid record first (`lib/paypal-sales.ts:612`) and writes the delivery/watch/owner/sales indexes only in the following pipeline (`lib/paypal-sales.ts:615-624`). A failure boundary after the first write leaves a captured payment recorded but not deliverable:

- when the `SET NX` is applied and its reply is lost, the new exact-reply handling throws at `lib/paypal-sales.ts:613`; `captureOrder()` catches that error and calls `watchLater()` (`lib/paypal-sales.ts:693-698`);
- when the paid `SET NX` returns `OK` and the following index pipeline fails, the error escapes `captureOrder()`;
- on either retry, `readPaid()` makes the order look already settled and returns `fresh: false`, so the return route does not call `handOverPayPal()` (`app/api/store/paypal/return/route.ts:23-26`);
- the sweep sees the paid record and removes the pending member (`lib/paypal-sales.ts:800-803`) without handing the purchase over.

The result is one completed provider capture and a durable paid record, but zero hand-overs, no owner index, no sales index, and no refund-watch member.

## Reproduction

Run from the repository root:

```sh
TMPDIR=/dev/shm node tests/z-2854-paid-delivery-run.mjs
```

The proof uses the public `captureOrder()`, `readPaid()`, and `watchPayPal()` entry points, the repository Redis stub, and a synthetic PayPal transport. It never contacts PayPal or performs a real payment. The assertions require one synthetic capture, one durable paid record, exactly one hand-over, the owner and sales indexes, and the refund-watch member.

At the reviewed head:

- healthy control: passes (`syntheticCaptures=1`, `paidRecorded=true`, `handOvers=1`);
- applied `SET NX` with a lost reply: fails (`syntheticCaptures=1`, `paidRecorded=true`, `handOvers=0`);
- successful `SET NX` followed by a refused index pipeline: fails with the same paid-without-delivery state.

Result: **3 tests, 1 passed, 2 failed**.

Against the exact parent implementation from `52c61612cc9a90cf47f684bd9555e8629876b08b`, with identical assertions, the lost-reply case passes while the post-`SET` index failure remains: **3 tests, 2 passed, 1 failed**. This separates the regression introduced by #2854 from the inherited failure boundary.

## Scope and validation

- The author's exact RED commit reproduces its intended failures, and the reviewed head passes all 65 author assertions.
- Linked validation passed **791 assertions in 20 groups**.
- Focused TypeScript (the two changed roots and imports), ESLint, `scripts/check_public_data.py` (4,102 tracked files, zero findings), and `git diff --check` all pass.

The product fix belongs to the owner of `lib/paypal-sales.ts`. It should make recording the paid capture and establishing a recoverable delivery obligation atomic or explicitly recoverable. A retry must deliver exactly once even when either Redis response is unknown; treating an already-written paid record as merely `fresh: false` is insufficient.
