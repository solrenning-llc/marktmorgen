# Creator payment default review — CA232

> **Atualização SR,27/10/2026 08h00 Fortaleza:** [Elegibilidade da plataforma Stripe](stripe-platform-eligibility.md) fixa a resposta menos favorável. Conta BR só conecta BR; planejamentoUS exigeSSN/ITIN,representante residente,endereço comercial real semcaixapostal. Payload/testes abaixo são histórico de transporte, não aceiteStripe nem prova de elegibilidade internacional. [MR](../AGENTS.md#mr--regra-de-margem-vigente-27-de-outubro-de-2026) substitui o piso60%histórico, preservando impostos/reservas/gates;MR2ainda precisa alterar os cálculos.

Reviewed 23 October 2026. This is a partial implementation record. It does not establish that every default, dispute, operating cost or tax risk is eliminated. Sales remain closed and the most-tax review remains binding.

## Account creation configuration

The actual `createConnectedAccount` function in `lib/stripe-connect.ts` sends `dashboard: "full"`, `defaults.responsibilities.fees_collector: "stripe"` and `losses_collector: "stripe"`, with merchant card-payments capability and API version `2026-08-26.dahlia`. The creator's supplied country is validated against the existing offered list.

`tests/connect-configuration.test.ts` intercepts every fetch, rejects any unexpected URL, exercises the actual function for every offered country, and asserts the complete account-creation payload and headers. Unapproved countries must make no request. All calls are synthetic: no account is created, no terms accepted and no provider contacted. PR #836 incorporated this regression after all 22 checks passed, including full validation after integration with the then-current main branch.

Stripe-owned reference checked on 23 October 2026: [Accounts v2 account types](https://github.com/stripe/ai/blob/main/providers/claude/plugin/skills/connect-recommend/references/account-types.md). Its full-dashboard SaaS example uses these fee/loss responsibilities. This code/reference comparison does not establish that every possible platform charge or liability is borne by Stripe, nor does it verify live account approval or terms.

## Verified checkout transport coverage

The following actual-function journeys intercept outgoing requests and assert the creator's `Stripe-Account`, the platform test credential acting on that connected account, and absence of destination/transfer/on-behalf-of routing fields. Each PR passed all 22 checks on its incorporated head; these are synthetic transport proofs, not live provider acceptance or liability decisions.

| Journey | Test | Incorporated PR | Merge time, Fortaleza, 23 October 2026 |
| --- | --- | --- | --- |
| Support payment | `tests/store-tips.test.ts` | #838 | 10:05:18 |
| Call package | `tests/call-packages.test.ts` | #839 | 10:33:49 |
| Payment request | `tests/payment-requests.test.ts` | #840 | 10:59:23 |
| Product, bump, membership and cart, with existing tax variants | `tests/checkout-tax-journey.test.ts` | #841 | 11:24:53 |
| Booking checkout through existing isolated host-booking fixtures | `tests/team-scheduling.test.ts` | #842 | 11:55:20 |

The booking proof checks every new checkout emitted by `holdAndCheckout` within those fixtures against its own store. It does not activate Teams, establish coverage for every booking variant or prove every platform payment path is connected-account commerce. Existing payment, tax, price, ownership, refund, permissions and booking assertions remain in place. No real account, payment, email or calendar submission was made.

## Assistant suspension and recorded-period admission

PR #844 incorporated actual `syncAssistant` regression coverage at 13:09:53 Fortaleza on 23 October 2026. Synthetic `past_due`, `unpaid` and `canceled` provider replies persist an inactive add-on and prevent model invocation. A confirmed dispute persists suspension, requests termination and refuses repurchase. This does not prove detection at the first failure in real time: the existing refresh schedule remains, and the dispute lookup covers only three recent invoices.

PR #845 incorporated the runtime correction at 13:33:25 Fortaleza. An expired renewing snapshot no longer invents a new 31-day AI pool during a two-day grace period. The actual `askAssistant` path is closed at the exact recorded end and four later points: no model call, no allowance and no speculative pool. Current recorded admission and an updated actual period remain usable. Final integrated head `b262b7b08c72ab04c99b65834c7d4136dc6eb725` passed all 22 checks; verify job 120520354001 logged the renewal cases at 13:14:56 Fortaleza.

These are partial admission controls. A subscription's active status or updated period is not independent proof of a paid invoice, settled funds or a funded dispute/refund reserve. Purchased buyer content and creator records are preserved.

## Caption refund evidence still required

Source review of `lib/billing.ts` and `lib/auto-captions.ts` found that `refundCharge` accepts an HTTP-success reply without validating the refund receipt, while caption callers ignore its boolean and remove the pending record even if the refund failed. The transcription submission accepts HTTP 200 unless `success` is explicitly false; a missing acknowledgment is not confirmation of acceptance.

No refund completion, loss elimination or automatic recovery is claimed from this review. A repair must preserve evidence of uncertain refunds and avoid duplicate charges/transcriptions; additional retries, retention or polling require priced bounds and funding before operation. No real refund or provider submission was made.

## Remaining scope

Account configuration and the listed checkout transport journeys now have regression evidence. Exhaustive proof for every sales/recovery path, the complete creator-charge inventory, paid-before-use credit admission, trial funding, first-failure suspension, disputes and guarantee exposure remain incomplete.

Existing review found `addToNextInvoice` in `lib/billing.ts` called by `lib/usage-billing.ts`. Historical video invoice allowances and unfinished invoice records must be distinguished from current tier playback admission; their presence alone does not prove every current playback creates a postpaid charge. Raw-file access, player-token lifetime and physical supplier-byte costs require their separate lifecycle review. Preserve creator records and purchased buyer access.

## Cost envelope before the regression

Incremental production operation cost for this test/documentation change is Store 0 monthly / 0 annual, Studio 0 / 0, Scale 0 / 0. No runtime request, retry, key, retention, supplier, service, allowance, price or visible limit is added. Existing automatic caps and reserves are unchanged. Actual CI, deployment and supplier invoices are unknown, never zero.

The complete CA232 implementation still requires maximum paid unit prices, worst-month full use for each plan and billing interval, all Brazil/US taxes, 100% of LLC costs, prepaid and disputed-payment reserves, and at least 60% net margin per customer and globally. Unknown costs fail approval. This partial configuration test certifies none of those conditions.

## Refund receipt confirmation — bounded partial repair

Official Stripe references read on 23 October 2026: [Refund object](https://docs.stripe.com/api/refunds/object) and [refund processing](https://docs.stripe.com/refunds). A refund can be pending, require action, succeed, fail or be canceled; HTTP success is not proof that money was returned. Insufficient available balance can leave a card refund pending. The original receiving fees and existing exposure reserve remain applicable.

`refundCharge` now reports true only for a succeeded refund object with a valid refund identifier, the requested PaymentIntent (including an expanded matching identifier), USD, and a positive safe integer amount. A requested partial amount must match exactly; a full-refund request omits amount as before. Invalid requested amounts make no provider request. This validates the receipt, not independent settlement at the recipient bank or the original full charge amount.

`tests/refund-receipt.test.ts` exercises the actual helper with every outgoing request intercepted. It checks full and partial requests, expanded intents, pending/failed/canceled/unknown replies, missing or mismatched receipt fields, unsafe amounts, provider refusal and invalid input. Each valid input makes only the existing single POST with the same platform scope, API version and idempotency key; no retry or additional lookup is added. A false result must not be retried under a fresh key.

This is not complete caption-refund recovery: existing captions callers still ignore the boolean and pending-record deletion remains unresolved. No new retry, polling or retention has been admitted without priced bounds. No refund completion, immediate reconciliation or total CA232 protection is claimed. Incremental runtime operations and storage are unchanged (Store/Studio/Scale 0 monthly / 0 annual); actual invoices remain unknown, never zero, and no all-tax margin is certified. Complete CI on this new head is required before incorporation.

## Explicit collection policy for the existing trial

Official Stripe SDK API declarations read on 23 October 2026: [Checkout Session creation](https://github.com/stripe/stripe-node/blob/master/src/resources/Checkout/Sessions.ts). They document payment_method_collection=always as the subscription Checkout default, while if_required can skip collection when nothing is due, and support trial_settings.end_behavior.missing_payment_method=cancel. No new trial-offer API or billing-version migration is introduced.

The existing platform checkout now sends always explicitly. Eligible trials retain their published duration and request cancellation at trial end if the payment method is missing, rather than permitting an uncollected post-trial invoice. Existing extra-store and returning-customer trial restrictions, annual authentication setting, price list, funding references and the bounded customer/price fallback are preserved. Both fallback attempts keep the collection policy.

`tests/billing-trial-policy.test.ts` intercepts every request and exercises every existing plan/cycle, stale customer and price fallbacks, and returning/additional-store cases through the actual helper. This confirms request construction, not independent confirmation of a card, provider acceptance, available cash or a completely funded trial. Payment-method choices are unchanged. The actual exposure/commercial review remains incomplete and sales remain closed.

Before code: incremental runtime monthly/annual Store 0/0, Studio 0/0, Scale 0/0. Only fields on existing requests change; no new provider call, service, storage, retention, trial duration or entitlement is added. Actual invoices remain unknown, never zero. No minimum paid base or all-tax net margin is certified. Complete validation on the new head is required before incorporation.

## Application fee refund receipt confirmation

Official Stripe [Application Fee Refund object](https://docs.stripe.com/api/fee_refunds/object), read 23 October 2026, defines a fee_refund identifier, amount, currency and application fee reference; unlike a payment Refund, this object has no status field. `settleFee` must receive a matching object/identifier, fee (including expanded identifiers), exact safe integer amount and known fee currency before the amount contributes to gaveBack/cents. Unknown fee currency and unsafe calculated amount refuse mutation. An unconfirmed reply throws into the existing failure counter; a run with any failed operation now reports complete=false. The existing request, idempotency key, deadlines and pagination bounds stay in place.

`tests/fee-refund-receipt.test.ts` exercises both the actual helper and actual daily aggregation against intercepted Stripe responses. It verifies correct platform/connected-account scopes, successful/expanded receipts, malformed and mismatched bodies, no retries, visible failure without invented returned amounts, no mutation for unsafe input and COMMISSION_LIVE=false. The existing share fixture now returns the documented receipt fields; all its prior behavior assertions remain.

This changes truthful reporting and bounded validation, not commission rates or release permission. It does not create a durable refund case, prove bank settlement, reconcile every old event or fund existing obligations. Existing owed refunds are not denied to meet a budget. No real fee or refund was submitted. Runtime incremental monthly/annual Store 0/0, Studio 0/0, Scale 0/0: same or fewer bounded provider operations and no new storage, retention or retry. Actual invoices and complete all-tax exposure remain unknown and cannot be treated as zero or certified at 60%.

## Caption refunds kept until Stripe confirms them — CA232 unit 1 (30 October 2026)

The gap recorded above ("captions callers still ignore the boolean and pending-record deletion remains unresolved") is closed in `lib/auto-captions.ts`. A caption refund that `refundCharge` does not confirm as succeeded (pending, requires action, failed, canceled, refused, timed out or unreadable) no longer deletes the request's record: it is kept with what is owed (`owed`, 400 days) and the video stays queued. Each later look first reads Stripe's own list of the payment's refunds (`refundsOnIntent`, `GET /v1/refunds?payment_intent=…&limit=100`, a list Stripe returns newest first and filters by PaymentIntent; refund `status` is one of `pending`, `requires_action`, `succeeded`, `failed` or `canceled`: [List all refunds](https://docs.stripe.com/api/refunds/list.md) and [The Refund object](https://docs.stripe.com/api/refunds/object?lang=go), read 30 October 2026). Enough succeeded: done. One pending or waiting for an action: wait. None in flight and not enough returned: ask for exactly what is left, under the first key while Stripe lists nothing, otherwise a key built from what Stripe listed, so two looks at once ask for the same refund and the same money is never returned twice. An unreadable or incomplete list (`has_more`) asks for nothing.

Bounds: at most `REFUND_LOOKS_MAX` (40) looks, 10 minutes apart and doubling to six hours (about ten days), inside the five-minute job's existing time budget and its 30 videos a run. Then the record is kept, marked stuck, taken out of the queue and never refunded by guesswork; an owed record that cannot be read is treated the same way. While a refund is owed, no new caption request is charged for that video. The course's studio page tells whoever may see the plan's card which refunds are not confirmed yet, and which have stopped being checked, with the support address; the Terms say a refund counts as made only once Stripe confirms it.

`tests/auto-captions.test.ts` models a Stripe that answers pending, failed and 500, replays idempotency keys, lists refunds, and fails to list them (500 and `has_more`). Mutations that delete the record on an unconfirmed refund, ignore a pending refund, reuse the first key after a failed one, or count any listed amount as enough each make it fail.

Cost per plan and interval (Store, Studio, Scale; monthly and annual): no new supplier, service or paid operation. Each owed refund adds at most 40 list reads and 40 refund requests on Stripe's API (no per-call price on Stripe's pricing page for these reads; not counted as zero) and one Redis record of under 1 KB for at most 400 days, only when a refund was not confirmed; the captions price already funds its own refund. Sales remain closed; nothing here certifies margin, settlement at the bank or complete CA232 protection. Units 2 to 6 of CA232 remain.

Review fixes (same unit, 30 October 2026): the amount asked back is capped at what the card paid, read from the PaymentIntent's `amount_received`; an invoice can take part of the price from the customer's credit balance, and that part cannot go back to the card. Owed refunds are also listed by store folder, so one owed for a video deleted since is still shown. A new caption request for a video whose refund is owed answers `auto_owed`. A refused request whose refund is not confirmed answers `auto_refund_pending`, which says the card was charged and the refund is not confirmed yet. The Terms state the ten-day limit and what follows it. The test's Stripe now replays a saved 500 under its key, as Stripe does.

Remaining gaps, recorded and not claimed as closed:
- the part of a price paid from a credit balance is not put back on that balance;
- a refund still legitimately pending after the ten days of looks is marked stuck and needs a person;
- two looks at once can lose one count of `looks`, which never touches money.

## Every charge Marktmorgen makes to a creator, paid before or after use — CA232 unit 2 (31 October 2026)

Scope item 2 of 232 [CA1]. Read from the code on main (31 October 2026, about 00h00 Fortaleza) and from the inventory of every path that charges money in [billing-correctness.md](billing-correctness.md) (569 [NC1] unit 1, table A), which lists the files, idempotency keys and tests of each path; this section adds only the question CA232 asks of each one: is the creator's money in before the cost it pays for can happen? Nothing here changes code, a price, a limit or a flag. Charges on a creator's own store sales are direct charges on the creator's account (section "Account creation configuration" above) and are not charges to the creator.

| Charge to the creator | Where | Paid before or after use | What can be used before the money is in | Who closes it |
| --- | --- | --- | --- | --- |
| Plan, first period (monthly or yearly) | `createBillingCheckout`, Stripe Checkout in subscription mode | **Before**: the period's invoice is paid at checkout | Nothing beyond the free trial below | Done |
| Free trial (`TRIAL_DAYS`) | Same checkout, `trial_period_days`, `payment_method_collection=always`, `missing_payment_method=cancel` | **Before payment, by design**: the trial's use is given, bounded by the trial allowances (for example `TRIAL_VIDEO_SECONDS`) | The trial's allowances, a card collected but not charged | Scope item 4 (funded exposure); not this unit |
| Plan renewal | Stripe's own subscription invoice at the start of each period | **Before** when the card pays; **after** when it is declined, because the plan's features keep running while Stripe retries | One renewal period's use, until the plan stops | Unit 4: stop costly features on the first day a renewal is declined |
| Plan change (upgrade, downgrade) | `switchPlan`: `proration_behavior=always_invoice`, `payment_behavior=pending_if_incomplete` | **Before**: Stripe's "Pending updates" page (read 31 October 2026, [docs.stripe.com/billing/subscriptions/pending-updates](https://docs.stripe.com/billing/subscriptions/pending-updates)) says "With pending updates, changes normally only apply if payment on the resulting invoice succeeds", and an unpaid update is voided when it expires (at most 23 hours, or the trial or period end if sooner) | Nothing, with one exception the same page states: "when a resumption attempt moves a paused subscription to `active` or `past_due`, Stripe applies a matching pending update even if the payment doesn't succeed" | Recorded below for the pause code (Codex's file) |
| Pause and restart | `lib/plan-pause.ts` → `restartPlan` | **Before**: the restart charges the paused tier on the saved card (unchanged here; the pause starts switched off, AV3) | See the plan change exception | Codex (AV1 step 3) |
| Store assistant add-on ($69 a month) | `createAssistantCheckout`, its own subscription | **Before** at checkout; **after** on a declined renewal only while Stripe still reports the new period as `active` (the add-on counts as active only for that exact status) and before the first payment attempt fails | Model calls inside the add-on's own pool for the recorded period only (`askAssistant` is closed at the recorded end, PR #845) | Unit 4 (first failure); unit 5 (a dispute is already handled for the add-on) |
| AI captions ($6 a minute a language, at least $35) | `chargeNow` from `lib/auto-captions.ts`: its own invoice, paid at once | **Before**: the work is sent only after the invoice is paid; a declined card voids the invoice | Nothing | Done; refunds kept until Stripe confirms them (unit 1, PR #1299) |
| Usage lines on the next invoice | `carryOut` (`lib/usage-billing.ts`) → `addToNextInvoice` | **After**: the only charge made after use | Video watched past `VIDEO_HOURS_INCLUDED` (400 hours a month); visits and orders owe nothing since 17 October 2026 (`owed: () => 0`). Paid playback is admitted only up to `PAID_VIDEO_HOURS` (4, 32 and 64 hours on Store, Studio and Scale; `lib/video-admission-rules.ts`, applied by `lib/plan-standing.ts`), below 400, so the line is not reached while admission holds — but `lib/video-admission-rules.ts` says admission "does not cap supplier bytes, buffering, replay or token lifetime", so this is not a demonstrated ceiling | Unit 3: remove the postpaid line or demonstrate a ceiling below what was paid |
| Refunds made by Marktmorgen (captions, the 30-day guarantee, a closing store's plan) | `refundCharge`, `lib/closing-plan-guard.ts` | Not a charge; money returned | — | Unit 6 (never more than was paid) |
| Platform share on a sale (`COMMISSION_LIVE` false) | Application fee on the creator's direct charge | **Before**: taken from the sale as it is paid, never billed later | Nothing | Off today |
| Credits to the creator (invite credit) | `lib/creator-invite-credit.ts` | Not a charge: a credit on the creator's customer balance, taken off Stripe's next invoices | — | — |

**What this shows.** One charge is made after use today: the usage line, reachable only past 400 hours of video when admission stops at 64 at most. Two charges run after use only when a card is declined: the plan renewal and the assistant's renewal, while Stripe retries. Every other charge is paid before anything it pays for can happen.

**For the pause (Codex's AV1 step-3 file, not edited here).** Stripe applies a pending plan change when a resumption moves a paused subscription to `active` or `past_due`, even if its invoice is not paid. If `restartPlan` or anything that resumes a subscription can meet a pending update (a plan change asked for and not yet paid within its 23 hours), the higher plan could start unpaid. Recorded for Codex in the queue item; not checked here.

**Cost.** None: a document only. Incremental runtime monthly/annual Store 0/0, Studio 0/0, Scale 0/0.

## No charge after use — CA232 unit 3 (31 October 2026)

The usage line above is closed in code: the video meter (`lib/watch-billing.ts`) owes nothing, as visits and orders have since 17 October 2026, so `addToNextInvoice` is not reached; a line written down before this and left unfinished is dropped by `settleUsage` (`lib/usage-billing.ts`) instead of being finished (dropping the record here does not remove an invoice item that a timed-out request may already have created at Stripe; none can exist while sales are closed and no store has passed 400 hours); the "videos paused" email no longer mentions a charge. `tests/watch.test.ts` fails if a meter owes again at 50, 101 or 1,000 hours past, if Stripe is asked for an invoice item, if an old unfinished line is charged, or if any file other than `lib/usage-billing.ts` calls `addToNextInvoice`. The Terms never published this charge, so no published price changes. Charges after use that remain are the two renewals on a declined card (unit 4). Cost: lower (no Stripe write on this path); Store/Studio/Scale monthly/annual incremental 0/0.

## A declined renewal stops what costs us to run — CA232 unit 4a (31 October 2026)

Scope item 5 of 232 [CA1], first part. Stripe's "How subscriptions work" page (read 31 October 2026, [docs.stripe.com/docs/billing/subscriptions/creating](https://docs.stripe.com/docs/billing/subscriptions/creating)) says `past_due` means "Payment on the latest finalized invoice either failed or wasn't attempted", that the subscription keeps creating invoices, and that what happens after the last retry (`canceled`, `unpaid` or staying `past_due`) is a Dashboard setting. Until this unit, `past_due` counted as a plan in good standing with every feature on, so a declined renewal was a period used before it was paid.

What the code does now:

| Step | Where | What happens |
| --- | --- | --- |
| Read | `stateOf` (`lib/billing.ts`) | `past_due` in its grace is an active plan with `renewalUnpaid: true`; the first payment after a trial stays "inactive" as before |
| Written down | `setSubscription` (`lib/store.ts`), from `recordState` (daily job, `lib/billing-sync.ts`), the studio page, and `recordUnpaidRenewal` before the failed-payment email (`lib/billing-reminders.ts`) | `renewalUnpaidSince` dated the first time, kept while unpaid, cleared when Stripe says it is paid, when the plan stops or for another subscription; the store leaves the list of stores that pay (`PAYING_INDEX`), so the shared ceiling for stores that pay nothing does not grow with it |
| Stopped | `isPaidUp` (`lib/billing.ts`) | checkout and PayPal sales, free copies, list sign-ups, import emails and API purchase emails |
| Stopped | `canUse(store, "email")` (`lib/plan.ts`) | emails to the list (`lib/mail.ts` gets an allowance of 0) |
| Stopped | `costStandingOf` (`lib/plan-standing.ts`): "ended" for a paid plan with an unpaid renewal | AI drafts (`aiAvailableFor`, `aiBudgetScopeFor`), the upload budget's scope (`uploadScopeFor`), lesson video (`videoLimitFor`: a store with no plan's 15 minutes) |
| Refused with its own words | the three upload doors (`app/api/store/file`, `vault`, `stream`) | `renewal_unpaid`, before any upload budget is reserved |
| Refused | the studio's picture upload (`app/api/store/image/upload`) and the list-email picture (`app/api/store/mail/picture`) | `renewal_unpaid` before a token is signed or a file written (the picture editors show their general error, because Stripe's upload client does not pass the reason on; the studio's notice at the top says why) |
| Stopped | `picturesLimitFor`, `taskRoomFor` (through `costStandingOf`) | no new community pictures and no new students' hand-ins; those kept stay |
| Kept | `standingOf` is unchanged | no closing, no closing notices, nothing deleted, the Store assistant add-on is not set to stop, export and deletion stay open, the studio keeps its plan's figure, buyers keep their access emails and what they bought (except lesson video), the store's page, domain and look stay |
| Not told twice | `app/api/cron/usage` | the "video hours used" email is not sent for a store whose renewal is unpaid: its video is paused for that reason, which the studio, the email and the Terms already say |
| Told | `components/renewal-unpaid-notice.tsx`, the failed-payment email, Terms `#renewal-unpaid` | the same three sentences (`lib/renewal-unpaid-words.ts`); the studio links to the open invoice's own Stripe page (`renewalInvoicePage`, read on each load; Stripe's "Hosted invoice page" guide, read 31 October 2026, says a URL retrieved through the API is valid for at least 10 days) |

When it is seen: at the daily job (09:00 UTC), at the failed-payment email (10:00 UTC), or at once when the creator opens the studio. Between the failure and the first of these, the plan's features run for at most about a day; the renewal period's allowances are the same ones a paid period would have used, so that day is inside one period's figures, not on top of them. Paying the invoice is seen the same way, and everything starts again.

Cost of this unit: lower, never higher. It adds one Stripe read per studio load only while a renewal is unpaid (no write), and removes the use of a period not paid for. Store, Studio and Scale, monthly and yearly: incremental cost 0 for a paying store; for a store with an unpaid renewal, the costly features above stop at the first sight.

Not in this unit (recorded, not claimed as closed): a buyer's review photo — closed by unit 4b1 (below); the other metered calls that still run on the plan's own figures (imports, integrations such as calendars, meetings and Discord, outbound webhooks, API reads), each to be split between what serves buyers' past purchases and what is new work — unit 4b, with the review photo; the deadlines, set from the costs, to the studio's suspension and the store's closing when Stripe keeps the plan `past_due` or ends it — unit 4c; a renewal whose invoice is not yet finalized or whose card has not yet been tried is still `active` at Stripe, so it counts as paid until the first attempt fails.

## A creator's dispute of a payment to us (232 [CA1] unit 5, 31 Oct 2026)

- **What happens.** The daily job (`app/api/cron/plans`, `lib/plan-disputes.ts`) reads the disputes on our own Stripe account opened in the last 120 days, at API version 2024-06-20 (the charge names its invoice, the invoice its subscription), finds the plan invoice and the store named in that subscription's metadata, and writes the dispute on the store (`planDisputes`, `lib/plan-dispute-rules.ts`). While the bank has not decided, what costs us to run stops exactly as for an unpaid renewal (`costsPaused`, `costStandingOf`, `isPaidUp`, `canUse("email")`, the upload routes answer `plan_disputed`). Decided for us (won, or an inquiry closed without a chargeback): it starts again. Decided for the creator: the period that payment covered stays paused to its end (a year from the dispute when the end cannot be read). Nothing closes and nothing is deleted. The studio shows a notice and the Terms say the same words.
- **Store assistant.** Unchanged: its own sync ends a disputed add-on and never sells it again (`lib/assistant-billing.ts`); this job skips add-on subscriptions.
- **Limits.** Read once a day, not at the moment of the dispute: we have no webhook on our own account, and adding one would need a step at Stripe that is not automatic. A dispute of a payment that is not a plan invoice (a one-off payment) is counted as unmatched and logged, not acted on; a store's earlier plan subscription counts only when it belongs to the same Stripe customer. No email is sent about it yet (the studio and the Terms tell the creator). A lost dispute as a cost in the worst case belongs to the margin review (lib/commercial-margin.ts, Codex's file) and is not changed here.
- **Bounds.** Every run reads the newest page first; what each dispute turned out to be is remembered (`nl:plan-disputes:seen`, 400 days), so a settled or unmatched one costs no Stripe read when listed again. An open one older than the 120-day list is read by id (at most 50 a run) until the bank decides. A decided dispute is never reopened. Past 500 disputes in 120 days the oldest are not reached (logged).
- **Inquiries.** An inquiry (`warning_needs_response`, `warning_under_review`) pauses too, until it closes; read as the reading with less exposure for us.
- **Not yet stopped by it** (as for unit 4a, see unit 4b): imports, integrations, outgoing webhooks, API reads; lesson video drops to the 15 minutes a month of a store with no plan.
- **Cost.** At most 5 list pages, one subscription read per dispute never seen before and 50 re-reads by id a day, inside 8 seconds of the daily job; no provider write.

## A buyer's review photo while a plan is unpaid or disputed (232 [CA1] unit 4b1, 31 Oct 2026)

- **What happens.** `app/api/store/review/route.ts`: when a review arrives with a photo and the store's costs are paused (`costsPaused`: a renewal unpaid, or a plan payment disputed and not decided for us), the photo is neither read nor stored; the words and stars are saved as usual and the buyer is told on the page, in their language: "Your review was saved, but the new photo was not added: this store is not taking new photos right now." (`reviewNotices.photoPaused`, all seven buyer languages, the formal register). A photo already on a review stays, can still be taken off by the buyer or the creator, and is still shown (a read, not new storage).
- **Why only the photo.** The words cost a few store commands inside the plan's existing review limits; the photo is new storage. The creator is told in the same words as the Terms, the studio notice and the failed-payment email: `RENEWAL_PAUSED_WORDS` and `DISPUTE_PAUSED_WORDS` now say "new uploads, your buyers' review photos included, are paused".
- **Cost.** Lower, never higher: one more read of a field already loaded; no new call.
- **Test.** `tests/review-photo-paused.test.ts` drives the route with a synthetic Stripe session, for an unpaid renewal and for an open dispute.
- **Recorded, not closed here:** a store whose plan has ended (`standingOf` "ended" or "none") still accepts a new review photo, inside the review limits; the creator's own page photo (`app/api/store/photo/route.ts`) has no paused check, unlike the other upload routes. Both are for the next part of unit 4b. The new notice uses the formal register while some older notices beside it on the same form do not (German, Spanish, Italian, Dutch); aligning those is outside this unit.


## Imports while a plan is unpaid or disputed (232 [CA1] unit 4b2, 31 Oct 2026)

While a plan's renewal is unpaid or a payment for it is disputed (`costsPaused`, `lib/plan-standing.ts`), moving a store from another platform is work nobody is paying for:

- **Refused, with the reason:** starting an import, a dry run and a step from the studio's page (`app/api/store/import/route.ts`), and every action of a ClickFunnels funnel migration (`app/api/store/import/funnel/route.ts`), answer 409 `renewal_unpaid` or `plan_disputed`; the studio says imports are paused, why, and what happens to an import already started (`IMPORTS_PAUSED`, `FUNNEL_PAUSED` in `lib/import-limits.ts`).
- **Kept:** an upload already under way may still send its rows and finish, so it is queued rather than lost (its rows count against the plan's own month of rows, as before the pause). An import already started is not worked on (`runImport` in `lib/imports.ts` returns it unchanged, so neither the page nor the five-minute job applies rows or sends its emails) and goes on where it stopped once the plan is paid. What it already brought in stays. While paused, each pass of the five-minute job keeps the import's record and its addresses still to be emailed alive, so a pause longer than their 14 days loses neither.
- **Open:** canceling, reading where an import stands and downloading the report of rows not brought in (within Store's monthly downloads while paused).
- **Figures:** a paused plan has Store's import figures, not its own (`importAllowanceFor` follows `costStandingOf`), except the rows of an upload already under way, which keep the plan's own month (`importRowsFor`).
- **Limit, said to the creator:** rows not brought in yet are kept `RAW_DAYS` (3) days from their upload, as always; past that, the import says the rest were let go and the creator starts again with the rows not brought in. Keeping them longer would be storage nobody is paying for.
- **Recorded, not closed here:** a store whose plan has ended (`standingOf` "ended") still imports on Store's figures, as before; whether that should stop belongs with unit 4c.
- **Cost:** a paused import costs one write of its record, two expiries and one read (and a third expiry while it holds the store's import slot) every five minutes, against the rows, emails and steps it no longer runs. The studio notice, the email and the Terms now name imports in `RENEWAL_PAUSED_WORDS` and `DISPUTE_PAUSED_WORDS`.

## New Zoom, Google Calendar and Meta connections while a plan is unpaid or disputed (232 [CA1] unit 4b3, 31 Oct 2026)

While a plan's renewal is unpaid or a payment for it is disputed (`costPauseCode`, `lib/plan-standing.ts`), a new connection is new work nobody is paying for: tokens to keep, meetings to make for each booking, and for Meta a daily read of the ad account (`lib/integration-pause.ts`).

- **Refused before any provider call:** starting a Zoom, Google Calendar or Meta connection, a team host connecting their own Google Calendar, and finishing a connection on the provider's return (`lib/meet-routes.ts`, `lib/meta-routes.ts`). A consent started before the pause is not exchanged for a token. The studio says why and what stays (`INTEGRATION_PAUSED_WORDS`; the Meta notice adds `META_READ_PAUSED`).
- **Waits:** Meta's daily ad-spend read and the read the account picker starts (`readMetaSpend` answers `paused`; the daily pass counts it skipped and tries again the next day).
- **Open:** disconnecting any of them, and canceling on the provider's page. Accounts already connected stay connected, so meetings already made for bookings already sold stay with the provider.
- **Starts again on its own** once Stripe records the payment or the dispute is won.
- **Said on the card:** choosing which Meta ad account to read while paused is still saved (it is a setting); the picker and the ad-spend card say its read waits instead of "read again once a day" (`readPaused` on the view).
- **Recorded, not closed here:** on connections already made, a team host's calendar tools (`app/api/store/host-calendar`: adding an iCal address, checking, listing calendars) and the test meeting (`lib/meet-test.ts`) still reach the provider; they serve accounts already connected and are left for unit 4b4's review. A store whose plan has ended (`standingOf` "ended") still connects as before; that belongs with unit 4c.
- **Cost:** none new; the check reads fields already loaded. The daily pass loads a paused store once a day as before, and makes no provider request for it. The studio notice, the email and the Terms now name the new connections and Meta's read in `RENEWAL_PAUSED_WORDS` and `DISPUTE_PAUSED_WORDS`.

## Reading a store through its API keys while a plan is unpaid or disputed (232 [CA1] unit 4b4c, 31 Oct 2026)

While a plan's renewal is unpaid or a payment for it is disputed (`integrationPauseWord`, `lib/integration-pause.ts`), a read through one of the store's API keys is work nobody is paying for: it is counted in the month the unpaid or disputed payment was for, and several reads (numbers, memberships) read the creator's Stripe account.

- **Refused, with the reason:** every read through `apiStore` (`lib/api-guard.ts`: the REST API's GET routes and every MCP method after `initialize` and `ping`) answers 409 `paused_unpaid` or `paused_disputed` with `API_READ_PAUSED_WORDS`, after the key is checked and before any of the month's API requests is taken or anything outside is read. A missing or wrong key still gets the same 401.
- **Open:** writes through a write key are not paused by this rule; taking back access (`DELETE /api/v1/access`) and removing a webhook endpoint (`DELETE /api/v1/hooks`) work, counted as API requests as usual (so they too stop once the month's API requests are used). Adding an endpoint stays refused by unit 4b4b2.
- **MCP says the true reason.** The MCP server used to answer every 429 (the minute's limit, the month's limit, a count that could not be made) as "Too many requests this minute" and every other refusal as "Send your Marktmorgen API key"; it now passes on the refusal's own sentence (a pause, the month used, the minute), keeping the key sentence for a 401.
- **Starts again on its own** once Stripe records the payment or the dispute is decided for us; a dispute decided for the store keeps reads refused until the period that payment covered ends (`DISPUTE_OUTCOME_WORDS`).
- **Recorded, not closed here:** adding writes through a write key (`POST /api/v1/leads`, `POST /api/v1/leads/labels`, `POST /api/v1/access` without a notice) still run while paused, inside the plan's month of API requests; whether they should wait too, with removals exempt from the month, is for the next part of unit 4b4 (or 4c).
- **Told:** `RENEWAL_PAUSED_WORDS` and `DISPUTE_PAUSED_WORDS` (studio notice, failed-payment email, Terms) now end with "Reading your store through your API keys, AI assistants included, waits too."; the developers page lists the 409.
- **Cost:** lower, never higher: one check of fields already loaded, before the month's count.
- **Test:** `tests/api-reads-paused.test.ts` (29 checks, a lost dispute included; the guard removed fails 10 of them).

## Adding through a store's API keys while a plan is unpaid or disputed (232 [CA1] unit 4c, 31 Oct 2026)

- **Refused, with the reason:** `apiAdder` (`lib/api-guard.ts`) answers 409 `paused_unpaid` or `paused_disputed` with `API_WRITE_PAUSED_WORDS` for adding a lead (`POST /api/v1/leads`), adding labels (`POST /api/v1/leads/labels` with any label to add, or an `add` that cannot be read), giving a product with no payment (`POST /api/v1/access`, with or without a notice) and adding a webhook endpoint (`POST /api/v1/hooks`, refused by unit 4b4b2 but only after it was counted; now before), after the key is checked and before any of the month's API requests is taken. A read-only key still hears 403 `read_only`; a missing or wrong key still gets 401.
- **Open:** removing labels only (`addsLabels`, `lib/api-write.ts`: it creates no enrollment), taking back access (`DELETE /api/v1/access`) and removing a webhook endpoint (`DELETE /api/v1/hooks`), counted as API requests as usual.
- **Why:** each of these is our work and may start more of it (a sequence a label starts, an email to a buyer), and the checkout already takes no new orders or free copies while paused.
- **Told:** `RENEWAL_PAUSED_WORDS` and `DISPUTE_PAUSED_WORDS` (studio notice, failed-payment email, Terms) now end with "Reading your store through your API keys, AI assistants included, waits too, and so does adding to it through them; removing labels, taking back access and removing webhook endpoints do not."; the developers page lists the write 409 and what stays open.
- **Cost:** lower, never higher: a check of fields already loaded, before the month's count; while paused, a labels request's body (at most 4,000 bytes, as before) is read before the count, to see whether it adds, so a malformed one is answered 400 without being counted.
- **Starts again on its own** once Stripe records the payment or the dispute is decided for us; a dispute decided for the store keeps these writes refused until the period that payment covered ends.
- **Test:** `tests/api-writes-paused.test.ts` (30 checks: refused before the count, removals open, a webhook endpoint, the dispute's sentence, a dispute decided for the store, writes again once settled).
