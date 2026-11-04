# Lost-dispute application-fee proof — November 4, 2026

CX-56(3): the pinned 2024-06-20 charge response no longer supplies the legacy dispute object used by owedOnFee. A lost dispute with no charge.dispute left the fee owed, while an unsupported expand[]=dispute could make the charge request fail outright. Both paths prevented the documented reversal. The synthetic regression failed before the product change; it calls the actual owedOnFee and settleFee helpers, not a reimplemented calculator.

## Corrected boundary

Charge reads retain invoice/payment-intent expansions and the existing version. Only charge.disputed === true triggers one GET /v1/disputes?charge=<exact charge>&limit=100 on the same connected account at 2024-06-20. A complete nonempty list, known statuses, matching charge/currency, valid distinct dispute IDs and at most 100 rows are required. A matching lost dispute sets the existing owedOn lostDispute input. Missing, truncated, foreign, malformed or unavailable evidence throws through the existing failure path before any refund POST. Won/open/warning outcomes retain the normal fee; an undisputed charge retains its original one-GET path. No unbounded pagination or alternate account fallback is added.

The existing refund amount, receipt validation, platform account scope and idempotency key are preserved. Synthetic tests verify full reversal of the fee, no second refund after the accepted amount is reflected, no write for unknown proof, connected-account/version scoping and no deprecated expansion. The older daily-job fixture now supplies the supported dispute-list shape instead of the removed charge field. No real request, fee, refund or dispute has been created or changed.

## Sources read November 4, 2026

- Stripe's official v13 migration guide (API 2023-08-16) records removal of support for dispute on Charge: https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v13
- The pinned dispute-list reference documents the charge filter and limit of 1–100: https://docs.stripe.com/api/disputes/list?api-version=2024-06-20

## Cost and release limits

This correction adds at most one connected-account GET per evaluated disputed fee, including repeated evaluation by the existing job. Each result is locally capped at 100 records and requires has_more=false. Existing request timeout/retry behavior remains unchanged. There is no new schedule, scan, persistence key or retention. The extra network wait and response-processing cost is UNKNOWN pending complete function/transfer accounting, never zero; no numeric profit or funded-capacity approval is inferred. Commission activation and all financial opening flags remain false as before. Prices, rates, visible limits, creator rights and sales gates are unchanged. Hosted complete/security/build checks and independent financial review are still required before merge.
