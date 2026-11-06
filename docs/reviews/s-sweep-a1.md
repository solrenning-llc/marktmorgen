# A1 rule-24 sweep: creator buyer report

Scope: `lib/[a-c]*.ts` on main `2bfa8ade8f59555b8d57aa03e554a99092a1285b`, excluding files already reserved or changed by open pull requests. This proof changes no product source.

## Finding

`lib/buyer-profile.ts` catches every failure from `readPaid` as `null`. `readPaid` itself also maps a missing outer Redis reply, an undefined slot, the wrong slot type, and unreadable JSON to `null`. The creator's buyer report then presents the persisted PayPal grant as a confirmed zero-dollar “brought” purchase instead of saying that the paid record could not be read.

The proof writes a real imported PayPal grant and a real paid row to `MemoryRedis`, then replaces only the paid-row `GET` reply. The healthy control reports a USD 42.00 sale. Confirmed absence reports a historical grant with no known paid amount. Four unknown replies must be unavailable; on current main they are silently reported as a zero-dollar brought purchase.

Proposed severity: **MEDIUM, creator-report integrity**. The report understates one buyer's paid amount and mislabels a PayPal sale. It does not alter an entitlement or send money. The proof does not claim that healthy Redis emits these replies.

Run:

```sh
node proofs/s/sweep-a1-buyer-profile-paypal.mjs
```

Expected on the proof commit: six checks, four causal failures and two passing controls.
