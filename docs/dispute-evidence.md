# Dispute evidence, ready for the creator to send (queue item 492 [DE1])

When Stripe reports a dispute on a store sale (on the creator's own Stripe
account), Marktmorgen assembles the records it already keeps for that one
purchase into an evidence package. The creator reviews it and sends it with one
click. Nothing is ever sent on its own.

State (rule VR): unit 1 is a pure rule, tested in a branch, not merged, not
published and not available to any customer. Nothing calls it yet.

## What already exists (reused, not rebuilt)

| Piece | File | What it does |
| --- | --- | --- |
| Packet of retained records | `lib/dispute-evidence-rules.ts` | Takes the records of one purchase (same account, store, purchase and buyer), drops expired ones, rejects mixed, malformed, duplicate or oversized batches without truncating, sorts them, lists missing kinds. `submitted: false`. |
| Dispute and purchase binding | `lib/dispute-purchase-binding.ts` | Pure check that a Stripe dispute, Checkout session, payment intent and charge belong together and to this store; gives the buyer email, product, amounts and dates. |
| Private dispute read | `lib/dispute-purchase-review.ts` | Reads the dispute and its Checkout session on the creator's account, after the paid-window reservation and one `integration` allowance unit before each of its two Stripe calls. Gives reason, `due_by`, `past_due`, submission count. |
| Retained pre-order row | `lib/dispute-preorder-review.ts` | One bounded Redis read of the pre-order row for the bound purchase. `given` is not proof of delivery. |
| Studio page and route | `app/studio/disputes/page.tsx`, `app/api/store/disputes/route.ts`, `components/dispute-purchase-review.tsx` | Read-only review under the `export` permission. No send action. |
| Stripe dispute statuses | `lib/dispute-statuses.ts` | Every status Stripe gives a dispute. |
| Field sources | `docs/gd1-stripe-evidence-sources-2026-11-10.md` | Stripe's `evidence` field names and caps, read in the official API reference on 10 Nov 2026. |

## Unit 1 (this branch): the field rule

`lib/dispute-evidence-fields.ts`, `buildDisputeEvidenceDraft(facts)`. Pure: no
network, storage, AI, email or submission.

Input: facts already read, each one exactly as read:

- `{ state: "known", value }`: the read succeeded and the fact exists;
- `{ state: "none" }`: the read succeeded and nothing exists;
- `{ state: "unknown" }`: the read failed, was not done, or did not come back in shape.

Facts: dispute id, status, reason, `due_by`, `past_due`, buyer email, product
description, the product's delivery kinds (download, course, call, community,
membership), and one read per record kind (receipt, confirmation email,
accepted terms, accepted refund policy, inbox messages, plus each delivery
kind of the product). A kind that applies and is absent from the input was
never read, so it is unknown, never "none".

Output, a draft for the creator's review:

- `evidence`: only Stripe text fields that have a real fact behind them:
  `customer_email_address`, `product_description`, `access_activity_log`
  (downloads, course progress, call attendance, community and membership
  access), `refund_policy_disclosure` (the accepted refund policy record) and
  `uncategorized_text` (receipt, confirmation email, accepted terms, inbox
  messages). Each line is a fixed label naming the kind of record, its UTC
  time and the record's own text. No placeholder, summary, estimate, claim of
  delivery or chance of winning is ever written.
- `fileCandidates`: Stripe fields that take an uploaded file (`receipt`,
  `refund_policy`, `customer_communication`, `service_documentation`) and the
  record kinds that could fill them. Not filled in this unit.
- `none` and `unknown`: what the screen must say is missing or could not be read.
- `blockers` and `maySend`: `maySend` is true only with no blocker. Blockers:
  any unknown fact; a status other than `needs_response` or
  `warning_needs_response`; a missing reason or deadline; a deadline at or
  before now; `past_due` true or missing; a field over its cap; the combined
  cap; nothing but an email to send. `maySend` only allows offering the send
  button later; `submitted` is always false.

Caps: 20,000 characters per text field and 150,000 combined (Stripe), on top
of the packet's own 64 records, 10,000 characters a record and 50,000 a
packet. A field over its cap is held back whole and named, never truncated.

Personal data: only the buyer's email (from the bound Stripe purchase) and the
records of that one purchase. No account, store, purchase, buyer or record
identifiers, no address, IP, name, signature or other buyer's data. Malformed
input or a record of another buyer rejects the whole draft with a generic
error that echoes nothing.

Tests: `tests/dispute-evidence-fields.test.ts`, synthetic facts only.

## Next units (not built)

2. **Read the facts.** A server reader that turns the existing records of one
   purchase into the tri-state facts: receipt and confirmation, downloads,
   lesson progress, call attendance, community and membership access, the
   exact terms and refund-policy version accepted at checkout with its time,
   and the store inbox thread of that purchase. Each read is bounded and its
   count is reserved before reading (paid-window reservation and the existing
   allowance, as `lib/dispute-purchase-review.ts` does), with a line in
   `tests/plan-cost-registry.ts` for its commands and bytes, and entries in
   `tests/store-data-registry.ts` for any key it reads. Read failures become
   `unknown`, never `none`. No retention is extended.
3. **The creator screen.** On `/studio/disputes`: the package in plain US
   English, field by field, with what is missing and what could not be read,
   the deadline from Stripe, and the reason Stripe gave, without promising a
   result. If an early fraud warning (312 [HQ1]) came first, offer the refund
   first. Accessibility per AX274.
4. **Send after one click.** Only on the creator's click, on the creator's
   account (`Stripe-Account`, the platform's existing `onAccount`), through
   Stripe's dispute update with the reviewed fields. Prepare (`submit=false`)
   and submit as separate steps, since Stripe submits by default when `submit`
   is omitted. An unknown send outcome is reconciled with a fresh read before
   any retry. File fields need uploads with purpose `dispute_evidence`, with
   their own cost line and reservation. Synthetic tests only.

Later extensions already queued reuse this rule rather than build another:
753 [IR1] (receipt, credit note and delivery records), 655 [WG15] and the
dispute parts of 601 [KB22] where they apply.

## Costs and caps

Unit 1 costs nothing to run: a pure function, no call, no storage. Later
units only use existing mechanisms and must reserve before spending: the
existing review costs at most two Stripe reads after the paid-window
reservation and two `integration` units. Stripe bills no API call, but the
reads, Redis commands, bytes, any file upload and the CI time are costs:
unknown is never zero, and the company's share belongs 100% to Marktmorgen
(FX275). Dispute fees and the disputed amount are the creator's on their own
account. No price, limit, commission or gate changes.

## Privacy

Unit 2 adds entries to `lib/person-data.ts` and `tests/store-data-registry.ts`
for whatever it reads, and no new retention: records past their existing
retention are not evidence. The package is shown only to people with the
`export` permission of that store and is not stored by this rule.

## Open questions

- **Field names re-read.** docs.stripe.com could not be reached from this
  session on 15 Nov 2026. The names and caps above come from the reading of
  10 Nov 2026 recorded in `docs/gd1-stripe-evidence-sources-2026-11-10.md`.
  `customer_email_address` and a 20,000 cap on `uncategorized_text` are not in
  that record: re-read the API reference, at the API version the account
  answers with, before the send unit, and correct the rule if needed.
- **Appeals.** `appeal_needs_response` is not treated as answerable here; how
  evidence is answered in an appeal is not confirmed.
- **`service_date`.** Its expected format is not confirmed; call dates stay in
  `access_activity_log` until it is.
- **Files.** Whether to render receipts, policies and messages as files (PDF/UA
  per AX274) for the file fields, and at what cost, is open.
- **Which records are required per reason.** The rule requires every
  applicable kind to be read, not to exist; whether some reasons should
  require a specific record to exist is a question for unit 3.
