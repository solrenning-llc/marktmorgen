# #2722 invoice payment variant evidence

Scope: review evidence only. The product branch and its CI are unchanged.

The exact candidate validates the embedded Invoice Payment list envelope, but
accepts every textual `payment.type`. Stripe's generated OpenAPI SDK currently
lists `charge`, `payment_intent`, and `payment_record`; the last variant carries
`payment_record`, which this candidate neither reads nor rejects.

The opt-in proof supplies one paid invoice backed by `payment_record` and one
control backed by a fully refunded PaymentIntent. On the candidate, the first
row is treated as zero refunds and produces a real synthetic balance-credit
POST, while the control remains uncredited.

Run:

```sh
node proofs/c2/run-2722-payment-type.mjs
```

Expected on the reviewed candidate: four checks, three causal failures and one
passing control. No real Stripe, Redis, account, payment, or personal data is
used.
