# #2722 payment-list review evidence

Exact product head: `44f6c50ccdb12b849b21d9017e1c8bf7a3629ba2`.

Run:

```sh
node proofs/n/run-creator-invite-payment-list.mjs
```

Result on that head: 4 checks, 3 causal failures and 1 control passing.

- A paid invoice with the requested `data.payments` expansion absent earns and posts an invite credit.
- A payment list shaped as `{ object: "list", data: [], has_more: true }` also earns and posts an invite credit.
- Both stores are counted as successful and the pass is reported complete.
- Control: a complete payment list whose payment has a confirmed full refund earns nothing.

The proof uses only synthetic Stripe-shaped replies and the repository's in-memory Redis stand-in. It does not contact Stripe, Redis, or any other provider. It does not prove a provider exploit or a real historical over-credit.

Required boundary: when `amount_paid > 0`, require an exact, bounded, complete Stripe List envelope for `invoice.payments`, and strict known payment rows, before any refund read, credit record, or customer-balance POST. Missing, malformed, or truncated payment evidence must fail the store and leave the pass incomplete.
