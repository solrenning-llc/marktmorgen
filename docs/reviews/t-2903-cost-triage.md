# Independent documentary review: #2903 E8 cost triage

Reviewed head: `69b163ef70f79baa9b538c18535be38136e5aec0`.
Reviewed document: `docs/reviews/c2-lot01-e8-cost-triage.md`, Git blob `2ca0355bb139acdf6add7453bd2bdfa7fd52187e`.
PR baseline: `87d9e6a1c4bf98f89ac7969e8e4093e8d1134231`.
Separately checked frozen main: `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`.
Reviewer: Codex T, independent of author Codex C2.
Claim `6698609238` and reservation `053d4c523c092c4d082c2fecefe28958a5c1444a` preceded source inspection and this local report.

## Disposition

**COMMENT: no high or medium documentary finding demonstrated; two low wording observations.** The single-file, 164-line addition is an explicit prerequisite audit. It does not claim implementation, completed margin costing, an entitlement, a funded allowance, or a runtime RED/GREEN. Its conclusion that custom recurring reports must not be implemented from the present company-mail path without a complete admission model is supported.

This is a local documentary review, not approval of a future product head. No product execution, tests, provider request, external contact, CI polling/retry, author/source change, commit, push, PR, or merge was performed. The C4 push freeze remains applicable until the literal required MAIN VERDE notice; nothing here relaxes it.

## Low observations

1. **Preserve the already chosen service-email category.** At document lines 29–32, 100, and 114–117, “no approved rule choosing that allowance” and “Choose the existing store allowance” can imply that HX1's category is still undecided. At both checked queue snapshots, `docs/codex-queue.md:11401` already requires the store's service-email allowance, independently of marketing email, while requiring verification of its actual per-plan quota and complete funding. `lib/email.ts:50–54,68–71` already distinguishes a store meter and its `email`/`transactional` debit from company/monthly/order paths; `tests/plan-cost-registry.ts:916–933` distinguishes the relevant existing cost lines. Mapping HX1 precisely to the existing counter, validating all invite/report/retry fan-out, and funding query/storage/rendering remain unproved. Suggested wording: “HX1 fixes service-email accounting; the exact existing counter, full fan-out debit and complete occurrence funding still require verification.” This is low because the audit repeatedly blocks runtime work and supplies no authorization to change a quota or charge.

2. **Describe the cron bounds as soft loop checks.** Document line 40 says each run “stops after 25 stores or 45 seconds.” Actual checks are at `app/api/cron/weekly/route.ts:58` and `app/api/cron/monthly/route.ts:46`; `out.looked` advances only after a report claim at weekly line 73/monthly line 61. The elapsed-time test runs before the next folder, not during the current store's nested reads, AI/chat work, or email fan-out. Invalid/unpaid/skipped folders also do not increment this claimed-store counter. Therefore these are at most 25 claimed store reports with a soft 45-second inter-iteration budget, not a hard cumulative I/O or wall-clock cutoff. Suggested wording: “The loop checks a 25-claimed-store maximum and 45-second elapsed budget before starting another folder; a current iteration can outlast that checkpoint.” This refinement does not invalidate the audit's stronger conclusion that the existing cron does not fund arbitrary E8 schedules.

## Baseline and main checked separately

Native Git tree identities show the following paths are byte-identical between the PR baseline and frozen main: both cron routes, `vercel.json`, `lib/stats.ts`, `lib/stats-report.ts`, `lib/email.ts`, the stats-range route, `lib/paypal-sales.ts`, all three cited custom-range presentation files, and `tests/store-data-registry.ts`. Thus source observations below apply to both snapshots without treating the author branch as current main.

The cost registry differs: baseline blob `fdd1f4df314b738aa0905bfe9921451717a923cf`; main blob `34e0642c39e48f37b4b637db87dd96904c9a470f`. The inspected delta adds cart-stock admission/read cost references and corresponding explanation. It does not add an E8 recurring-report cost line or change scheduled-report email classification. The report should ideally pin its baseline explicitly; its PR metadata supplies the baseline above.

Open PR numbers listed by the author are historical coordination observations, not durable proof that a path remains occupied now. Their live statuses were not polled for this review. Runtime work would require a fresh ownership check after the freeze and applicable dependencies clear.

## Supported source observations

- `vercel.json:57–66` schedules weekly at `20 * * * 1,2` and monthly at `25 * 1,2 * *`. These are existing fixed jobs, not creator-selected schedules.
- Owner and weekly-team sends use `meter: { by: "company" }` at weekly lines 96/115 and monthly line 81. Weekly lines 107–115 recheck selected recipients against the current team and `stats` permission. `lib/stats-report.ts:312,320–323` caps saved team selection at five; monthly has no corresponding team-send loop. This is existing behavior, not a proposed new entitlement.
- Fixed builders expressly mark incomplete/unavailable financial readings at `lib/stats-report.ts:402–409,515–516,546–547`. `readNumbers:121–133` calls `readStats` and conditionally `readSales`; it is not a minimal custom-field reader.
- The stats-range route checks `jsonAccess(request, "stats")` before the read, runs range/title/mark reads in parallel, and returns private/no-store data (`app/api/store/stats/range/route.ts:13–29`). `components/custom-range.tsx:138–148,194,208–227,236,266,331` corroborates local selection, chart controls and CSV presentation. These controls do not constitute saved recurring report definitions.
- `docs/highlevel-gap-matrix.md:53` is accurately represented as an internal H08 partial classification. This review does not independently certify current competitor capabilities or documentation.
- Fixed report keys are registered at `tests/store-data-registry.ts:894–898`; that registration does not establish funding for proposed custom configuration, external invitations, or delivery state. The inspected registry has no named E8/HX1 recurring-report cost line.
- E8/HX1/D8 remain requests and constraints, not current customer features. HX1's confirmations, opt-out, accessible email/text, optional validated PDF, aggregated real metrics and absence of buyer personal data are properly treated as future requirements. No new visible limit is approved by this review.

## Pure arithmetic verification

`lib/stats.ts:56,1734–1748` retains 400 inclusive UTC dates. At `1762–1772`, span `s` contributes `s` HGETALLs, `s` daily PFCOUNTs and one whole-period PFCOUNT: **2s + 1**. A retained immediately preceding period adds one PFCOUNT plus `s` HMGETs: **3s + 2**. Both adjacent equal spans must fit the same 400 retained dates, so the comparison branch has `s <= 200`, maximum **602**. The noncomparison branch allows `s = 400`, maximum **801**. Enumerating these integer cardinalities in a pure calculation confirmed the author's overall traffic-only 801 envelope; no product function was executed.

At `lib/stats.ts:1824`, `readRange` passes 20 to `readPaidSales`. Its shared walker (`1067–1097`) can traverse 20 checkout-session pages and 20 payment-intent pages separately; the PayPal limit argument is `20 * 100 = 2,000`. `lib/paypal-sales.ts:975–982` probes up to 2,001 index IDs to detect truncation, then reads at most 2,000 sale records. The audit's record statement is correct, but a later byte/command budget must retain this look-ahead probe and the rest of the reader's work. None of these query envelopes is the monthly cron schedule or a proof that recurring E8 work is funded.

## Method and limits

The bounded review used 16 distinct source/document paths, full author document/diff, exact PR metadata, focused queue excerpts and Git identity/delta checks. Nine complete implementation/registry files total 531,427 retrieved text code units; remaining excerpts and the author patch keep retrieved review text below 0.8 MiB. There were 18 logical retrieval batches, leaving the requested independent report read within the 20-read/2-MiB ceiling. No official external sources were needed because no provider price, tax rate, competitive feature, or commercial cost was independently asserted or recomputed. Source inspection and pure integer arithmetic provide documentary evidence only.

No runtime RED/GREEN, future margin result, invoice amount, new provider/price/model, commercial allowance, account permission, customer contact, or deployment certification follows from this report. Unknown full funding remains unknown and blocks new runtime spend.

## Focused published-head return after C4-3100

Reviewed final head: `246209299128ce363c29ead6628fc3aba33a12d2`.
Author document blob: `b0984646b58ee0648cfaf011234798e005f98ce2`.
Main parent: `5aae97e8a0491952192aa7beefd6741917e6bc28`.
Nominal request: `6700697150`; focused claim: `6700944781`, before inspection of the published delta.

**Both prior LOW observations are closed. No new high, medium or low documentary finding was demonstrated in this focused delta.** The complete current 171-line document and the complete original-to-final document diff were read. Only this one document differs from current main. The weekly/monthly cron routes and `lib/email.ts` are byte-identical between the original reviewed head and this final head. The queue delta contains historical cart-stock and ready-cart-link progress, without changing the cited HX1 service-email requirement.

- The document now consistently preserves HX1's already chosen store service-email category, independently of marketing. It asks for verification of the exact existing counter, complete fan-out atomic debit and query/render/storage funding; it no longer asks coordination to choose the category again. The current company meter is explicitly not implementation of that assignment.
- The cron wording now describes at most 25 claimed reports and a 45-second check before the next folder iteration. Skipped folders do not count, and current nested reads/sends can outlast the checkpoint. The table and reader/cost sections consistently avoid treating these checks as a hard cumulative I/O or wall-clock cutoff.
- The original prerequisite status and unfunded/unknown boundaries remain explicit. No runtime, quota, price, entitlement, meter, schedule, provider, author source, test or workflow was changed by this documentary repair. The unchanged query arithmetic was not rerun and is not presented as new runtime evidence.

Method: serial, bounded documentary return only, full one-file source/diff plus Git blob identities and queue delta. No external research, provider request, runtime RED/GREEN, type/lint/build/CI result, margin certification, global absence claim or approval of later implementation is asserted. A targeted personal-data scan and whitespace check cover this report only. The freeze was released by C4-3100 before evidence publication; author merge remains the author's responsibility and requires its own current gates.
