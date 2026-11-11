# Opening readiness status — 11 November 2026

What still stands between Marktmorgen and its first paid plan, read from `origin/main` at `47dbe61d` on 11 November 2026. It follows the owner's order for opening (AV1, docs/codex-queue.md, section "AV — Ordem vigente para abrir as vendas") and its step 12, the ordered list of what only the owner can do.

This is a snapshot, not a certification. It changes no flag, price, limit, commission, gate, review or record. A state written here is the state found in the code and the queue on that day; "merged" never means "available to customers" (VR, item 1). Every gate below stays exactly as strict.

## How opening is decided in the code

`lib/opening.ts`:

```ts
const OPENING_REQUESTED: boolean = false;
export const PLANS_ON_SALE: boolean = commercialPlansMayOpen(OPENING_REQUESTED) && taxGateValid() && deemedSupplierReady() && stripePlatformEligibilityReady();
```

A store sells only with a plan (`canSell` in `lib/store-checkout.ts`), so while `PLANS_ON_SALE` is false no store checkout opens either. The Store assistant add-on (`ASSISTANT_ON_SALE`) also needs `PLANS_ON_SALE`.

| Condition | Where | State on 11/11/2026 | Why |
| --- | --- | --- | --- |
| Owner's request | `OPENING_REQUESTED`, `lib/opening.ts` | **false** | Set only by the owner, and only once every other condition below is ready and the minimum customer base is computed (AV1, "Cuidado com os custos"). |
| Commercial review | `commercialPlansMayOpen`, `lib/commercial-margin.ts` | **false** | `CURRENT_COMMERCIAL_MARGIN_REVIEW`, `CURRENT_EXPOSURE_BUDGET_POLICY` and `CURRENT_CONTRACT_FUNDING_POLICY` are all `null`; `contractLifecycleReady()` is false (see below). |
| Tax gate setting | `taxGateValid`, `lib/tax-gate.ts` | true | The gate reading is `most-correct` (TX policy). This only says the setting may be judged on; it is not permission to sell, and scoped tax evidence is still required inside the commercial review. |
| Deemed supplier (EU art. 9a, UK, US, other) | `deemedSupplierReady`, `lib/deemed-supplier.ts` | **false** | `DEEMED_SUPPLIER_RECORDS` is empty. All four jurisdictions (`EU`, `UK`, `US`, `other`) need a record of a built and tested treatment. |
| Stripe platform eligibility | `stripePlatformEligibilityReady`, `lib/stripe-platform-eligibility.ts` | **false** | `CURRENT_STRIPE_PLATFORM_ELIGIBILITY_REVIEW` is `null`: no US-company platform account, and no dated proof for US, CA, GB and EUROPE direct charges. |

### Inside the commercial review

`commercialPlansMayOpen(requested)` needs all of these together:

| Part | State | What it needs |
| --- | --- | --- |
| Commission readiness | ready | `COMMISSION_PLANS_PUBLISHED` is false, so no commission proof is needed. |
| Contract lifecycle (`CONTRACT_ADMISSION_COVERAGE`, `lib/contract-funding-rules.ts`) | **not ready** | Core keys must all be true. Today: `checkout` true, `planSwitch` true, `resourceAllocations` **false**, `renewals` **false**, `settlementAndReserveReconciliation` **false**. `pauseRestart` is false and optional while `PLAN_BREAKS_ENABLED` is false (AV3: the plan pause starts off). |
| Exposure budget policy (`lib/exposure-budget-policy.ts`) | **null** | A reviewed, dated budget for free trial, refunds, non-payment and post-cancellation retention, bound to the current price-and-rights snapshot. |
| Contract funding policy (`lib/contract-funding-rules.ts`) | **null** | Reviewed reserves and funded grants per plan and interval, bound to the same snapshot. |
| Commercial margin review (`lib/commercial-margin.ts`) | **null** | Per-customer worst case for every plan and interval with 100% of rights, scoped tax evidence (TX), cost and limit evidence, verified fixed-cost allocation (FX275), enforced prepaid usage, upload and AI spend policies funded. |

Under the MR rule a unit must have positive net at full use, and the company must be covered from a computed minimum base. Unknown costs fail; they are never zero.

## AV1 steps and their state

| AV1 step | Item | State found | Remaining |
| --- | --- | --- | --- |
| 1 | 495 [SR6] | Owner decided on 28/10/2026, 18h41 (SD1): Delaware LLC with a US Stripe platform account. | Only the LLC route's quantification, now inside 275 [FX1]. |
| 1 (SD1) | 470 [SR4] | Roadmap merged as a document (docs/us-llc-owner-roadmap-2026-10-28.md). | Every real step is the owner's (group A). |
| 2 | `stripePlatformEligibilityReady` | Built for the LLC route; review `null`. | Real dated proof (group A), then recording it. |
| 3 | AB(a) / AV3 | Plan pause, restart and pause notices start off. | Build renewals, resource allocations and settlement/reserve reconciliation coverage; then real reviews (group A for the numbers). |
| 4 | 472 [TX2], 473 [TX3] | Partly merged (most-correct reading, sales evidence journal, threshold evidence). | US per-state counters and the parts the step 5 records need. |
| 5 | `DEEMED_SUPPLIER_RECORDS` | Not built. No checkout refuses a jurisdiction before a charge. | "refuse-consumers" checkout refusal per jurisdiction (with tests), or "collect" where built; then the records. EU/UK collection (7, 8, 300–303) comes right after opening. |
| 6 | 275 [FX1] | Inventory and monthly/annual gate merged; every ceiling in `CURRENT_LLC_FIXED_COST_CEILINGS` is `null` with empty evidence. | Real contracts and ceilings (group A), then the minimum customer base. |
| 7 | 89 [C2-CAPACITY], 232 [CA1] | Guards merged; 89 waits for real configuration and rates; 232: API-write units 1–6, 4b and 4c merged, while the original 4c, the free-trial funding and the proof that every path is a direct charge stay open (see #3669). | 89: owner's real figures. 232: remaining units. |
| 8 | 305 [SY1], 306 [SY2], 307 [EC1], 91 [D2-EU-WITHDRAWAL], 98 [D2-COMPLIANCE-REVIEW] | 305 partly merged; 306 unit 1 merged; 307 merged (#1292), published per the queue and off behind the gates, with end-to-end use and three test gaps still open; 91 built and off; 98 noted in progress on 31 October with no update since (its state line still says to do). | 305 refund button; 306 next units; 307: end-to-end use and its three test gaps; 98 remaining checks. |
| 9 | 114 [E2-AFFILIATE-TAX-FORMS] | Queued. | Build W-9/W-8BEN and 1099 export, or start affiliate payouts off (AV1 allows it). |
| 10 | 465 [MR2], 466 [MR3] | Partly merged; real profit input `null`. | The criterion the commercial review needs; the monthly report comes after opening. |
| 11 | Cost items (k) | 309 [EM1] and 313 [CV1] partly merged; 319, 315, 320, 331 not started. | Only those that lower the first months' cost or the minimum base. |
| 12 | This summary | This file. | Keep it current as conditions change. |

Running in parallel: 538 [AB1] and 448 [LE1], both queued. The DPF/SCC check of current suppliers (SV policy) has a dated documentary review (docs/current-provider-transfer-evidence-2026-10-27.md); which plan and agreement actually covers each account is still unproven.

## Group A — only the owner can do these

In the order they unblock opening:

1. **Form the company.** Delaware single-member LLC, registered agent, EIN without SSN (docs/us-llc-owner-roadmap-2026-10-28.md).
2. **A real US business address**, never a PO box or the registered agent's address (SR5).
3. **A US bank account in the LLC's exact name.**
4. **The US Stripe platform account in the LLC's name**, then dated written or account proof that it can connect creators in the US, Canada, the UK and Europe with direct charges. Keep any message asking for SSN or ITIN (SR5).
5. **Answer or obtain the Stripe Tax question** (who pays the Stripe Tax fee on direct charges on creators' Standard accounts); until then the dearer reading in `lib/receiving-costs.ts` stays.
6. **Real fixed costs**: contracts and invoices for every LLC fixed cost (Delaware, registered agent, address, domains, tools, GDPR/DSA/UK representatives, and INSS only if the remuneration facts make it due: unresolved, TX point 5 and `lib/llc-fixed-costs.ts`), with monthly and annual ceilings and the reserve review (275 [FX1]).
7. **Real supplier configuration and rates** for capacity (89 [C2-CAPACITY]): plan, price tier and ceiling of each paid supplier account (Vercel, Upstash, Resend Pro, SES, R2, video, Anthropic).
8. **Proof of the Resend Pro account** and of real SES sending, needed by 309 [EM1].
9. **Supplier agreements**: which plan, entity and DPF/SCC terms cover each current account (SV policy). No terms are accepted by an agent.
10. **Legal and commercial decisions** recorded in "Depende do dono", including the per-jurisdiction choice between collecting and refusing consumers where the law makes Marktmorgen the supplier.
11. **Approve the reviews** once agents have filled them with proven numbers only: the exposure budget, contract funding and commercial margin reviews, and the Stripe platform eligibility review.
12. **Set `OPENING_REQUESTED`** last, after the minimum customer base is computed and shown.

## Group B — agents can do these, without the owner

Each one ends "built and tested, off behind the gates" until group A is done. None changes a flag, price, limit, commission or gate.

1. A single tested list of the opening conditions in code, so this summary cannot silently drift from `lib/opening.ts`.
2. Renewals, resource allocations and settlement/reserve reconciliation coverage (AV1 step 3; core keys of `CONTRACT_ADMISSION_COVERAGE`).
3. The "refuse-consumers" checkout refusal per jurisdiction before any charge, with tests (AV1 step 5). Recording it in `DEEMED_SUPPLIER_RECORDS` stays a reviewed step.
4. US per-state counters and threshold switch-on (472 [TX2], 473 [TX3], TX point 11).
5. 232 [CA1] remaining units; 305 [SY1] refund button; 306 [SY2] next units; 307 [EC1] end-to-end use and its three test gaps (the item itself is merged, #1292); 98 [D2-COMPLIANCE-REVIEW] remaining checks.
6. 114 [E2-AFFILIATE-TAX-FORMS], or keeping affiliate payouts off at opening, with a test.
7. The 465 [MR2] criterion the commercial review needs and 466 [MR3] with current prices.
8. Cost items (k) that lower the first months' cost or the minimum base.
9. The minimum customer base calculation, ready to run as soon as group A item 6 supplies the figures.

## Not checked

No provider account, Stripe dashboard, production deployment or real customer data was read. The states above come from the code on `origin/main` and from the queue's own state lines; an item without a state line is written as queued.
