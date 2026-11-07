# E8 scheduled custom reports: existing coverage and cost boundary

Status: **documentation-only audit; no product implementation or delivery**.

This review covers queue item 25 `[E8]` and its documented overlap with 405
`[HX1]` and, in part, 11 `[D8]`. It records what the current code already does,
the remaining delta, and the cost/admission decisions that must precede any
runtime work. It does not change a price, plan right, visible limit, email
allowance, provider, gate, account, or production schedule.

## Result

E8 is not already implemented. The repository has two reusable foundations:

1. fixed weekly and monthly reports sent to the creator, plus weekly copies to
   selected current team members; and
2. an on-demand custom-date dashboard with filters and CSV downloads.

It does not have a saved custom report definition, a creator-selected recurring
schedule, an external-recipient confirmation lifecycle, or a cost admission
that reserves the query, rendering, storage, and complete email fan-out before
work starts.

Product implementation remains blocked for three independent reasons:

- `lib/stats-report.ts` is changed by open PR #2876;
- `tests/plan-cost-registry.ts` is changed by open PRs #2848, #2849, and
  #2852; and
- the current scheduled reports use `meter: { by: "company" }`, while E8 says
  the send is inside an allowance and HX1 already assigns report emails to the
  store's service-email allowance, independently of marketing. That category is
  decided; the exact existing counter, atomic fan-out debit, and complete
  query/render/storage funding still need verification. The current company
  meter does not implement that assignment.

Unknown funding is therefore not zero and cannot be treated as admission.

## Existing coverage

| Capability | Current source | What exists now | E8/HX1 delta |
| --- | --- | --- | --- |
| Fixed scheduled reports | `app/api/cron/weekly/route.ts`, `app/api/cron/monthly/route.ts`, `vercel.json` | Weekly job runs hourly on Monday and Tuesday; monthly job runs hourly on the first and second day. A run handles at most 25 claimed reports and checks elapsed time against 45 seconds before another folder iteration. Skipped folders do not count as claimed reports, and a current store's nested reads/sends can outlast that checkpoint. | No creator-defined schedule or saved report configuration. These soft loop checks are not a hard total I/O/wall-clock ceiling or a monthly custom-report budget. |
| Fixed report content | `lib/stats-report.ts` | Weekly and monthly message builders select a fixed set of numbers. Unknown financial coverage is described as unavailable rather than reported as zero. | E8 needs an explicit, bounded selection of report fields. HX1 names visits, sales, revenue net of refunds, subscribers, and aggregate affiliate numbers by period. |
| Creator recipient | weekly/monthly cron routes | The store owner receives the fixed report. | E8 must define whether every custom report includes the creator or only explicitly selected recipients. |
| Team recipients | `weeklyTeam`, `MAX_WEEKLY_TEAM` in `lib/stats-report.ts` | Weekly only; selected addresses are rechecked against current team membership and the `stats` permission before each send. Maximum five chosen team members. | Monthly reports do not use this list. External recipients are absent. HX1 allows up to three confirmed addresses beyond the team and requires confirmation, immediate opt-out, and revocation. |
| Unsubscribe | `weeklyToken`, `weeklyMemberToken`, `/api/store/weekly` | Owner and weekly team copies have stop links. | There is no scoped external-recipient invitation, confirmation, version, expiry, or report-specific authorization lifecycle. |
| Custom period | `app/api/store/stats/range/route.ts`, `lib/stats.ts` | An authenticated creator can read a UTC date range kept for at most 400 days. | The range is requested interactively and is not saved or scheduled. |
| Custom presentation | `components/custom-range.tsx`, `lib/custom-range-view.ts`, `lib/channel-reports.ts` | The creator can filter/sort loaded channels and products, select chart metrics/grouping, and download CSV reports. | These browser-local choices are not a durable report schema and are not an email renderer. |
| Cost ownership | `lib/email.ts`, `tests/plan-cost-registry.ts` | Scheduled reports are classified as company email. List, store, transactional, and company meters are different accounting paths. | HX1 already selects the store service-email category, independently of marketing. No current store allowance is taken for these scheduled reports; the exact counter mapping and atomic admission must be verified before claiming that assignment is implemented. |
| Stored state | `tests/store-data-registry.ts` | Fixed report sent/off/team keys are registered and bounded. | No key family or byte/retention bound exists for custom definitions, recipients, invitations, delivery receipts, retry state, or generated artifacts. |

The HighLevel gap matrix already classifies H08 as partial: fixed dashboards,
custom date ranges and CSV, and a fixed weekly email exist; widget-built
dashboards and reports to outside addresses do not.

## Query ceiling is not yet an E8 budget

Two existing readers are candidates, but neither is admitted for an arbitrary
recurring custom report.

### Fixed report reader

`readNumbers` calls `readStats` and, for a connected sales source,
`readSales`. The latter can read sales, renewals, refunds, disputes, and PayPal
coverage. The fixed jobs currently rely on their run schedule, a claimed-report
count and an elapsed-time check between folder iterations as company work.
That check does not interrupt a current store's nested I/O. There is no
E8-specific per-store reservation that
counts the selected query before those reads.

### Custom-period reader

`readRange` validates a maximum retained period of 400 days. For a span of
`s` days, its traffic pipeline contains:

- `2s + 1` Redis commands when the preceding comparison period is not kept;
  or
- `3s + 2` Redis commands when that preceding period is kept.

The largest traffic-only command envelope is therefore 801 commands for a
400-day range without a preceding kept period. This is before catalog titles,
automatic marks, rendering, storage, email, and financial-provider work.

When paid sales are available, `readRange` calls `readPaidSales(..., 20)`.
That may walk up to 20 pages of checkout sessions and 20 pages of payment
intents, while also reading up to 2,000 PayPal sale records. Provider calls may
have no per-call invoice, but function time, CPU, database work, response bytes,
and fallback/retry exposure are not zero.

The current cost registry has no E8 line that prices this recurring query or
proves it can run at the proposed frequency for every entitled store. A future
implementation must either use a smaller explicitly bounded report reader or
reserve this complete worst-case envelope before the first read. Selecting a
small set of output fields after a full read does not reduce the read cost.

## Cost and admission ledger required before runtime work

| Cost surface | What must be bounded before the spend | Current blocker |
| --- | --- | --- |
| Schedule | Runs per store and billing window; UTC/time-zone rule; catch-up behavior; global queue size; stores and reports per invocation; function duration. | Existing cron limits claimed reports and checks time between iterations; it supplies neither a hard current-I/O cutoff nor a lifetime/monthly budget for custom schedules. |
| Query | Exact reader, period, Redis commands/bytes, provider pages/bytes, and whether metrics can share one read. | No E8 cost line or pre-read debit. `readRange` can be large; `readNumbers` reads more than a selected minimal report may need. |
| Configuration | Number and maximum serialized bytes of report definitions, metric identifiers, period, schedule, authorization version, and retention/deletion. | No schema, data-registry family, or storage admission. A value is not free because it is small. |
| Recipients | Creator, current team, and external confirmed addresses; invitation, confirmation, opt-out, replacement, and revocation records; exact fan-out. | HX1 says up to three external addresses beyond the team, but E8 has no approved combined fan-out or storage model. |
| Email | Every invitation, confirmation if any, report copy, retry, and failure notice; sender/fallback cost; unknown delivery result. | Current scheduled reports use the company meter. HX1 already assigns the store service-email allowance, independently of marketing; the exact existing counter and atomic debit for the complete fan-out must still be verified before provider dispatch. That email category alone does not fund query, rendering or storage. |
| Rendering | Text and accessible HTML bytes/CPU. A PDF would add generation CPU/memory, validation, storage, attachment bytes, and egress. | No funded PDF or PDF/UA pipeline exists. HX1 requires the accessible email/text path even if PDF is later approved. |
| Retry/idempotency | Durable report occurrence, recipient occurrence, provider attempt identity, uncertain acceptance, backoff, expiry, and cleanup. | Fixed `claimWeek`/`claimMonth` is not a per-report/per-recipient delivery ledger. A lost provider response cannot authorize an unbounded resend. |
| Privacy and authorization | Store isolation, minimum recipient data, exact `stats` permission for team, explicit external confirmation, immediate opt-out, retention and erasure. | External recipients are not part of the current model. No buyer identity or order-level data may be added to the report. |
| Unknown financial coverage | Explicit unavailable/partial output for sales, refunds, disputes, subscribers, or affiliate data. | Unknown must not become zero or a complete total. Existing fixed messages provide patterns, but every selected metric needs its own completeness contract. |
| Company fixed cost | Cron/function capacity, monitoring, locks, global queue/cursors, and provider account overhead. | Existing “company” classification is not a reviewed E8 monthly/global ceiling. |

## Decisions required from coordination

No runtime branch should be opened until these decisions are explicit:

1. **Scope composition.** Confirm whether E8 is implemented once as the shared
   engine for HX1/D8, with HX1's external-recipient rules, or whether E8 stops
   at creator/current-team recipients. Do not build two schedulers.
2. **Allowance implementation.** Preserve HX1's already chosen store
   service-email category, independently of marketing. Verify its exact existing
   counter, applicable states, and atomic debit for report copies, invitations,
   confirmations and retries across the complete fan-out. Do not reopen that
   category decision or invent an unlimited/new allowance. The current company
   meter cannot silently count as implementation; query/render/storage also
   require their own complete funding before work.
3. **Entitlement.** Confirm which existing tiers/trial states may save and run
   a report. This audit does not infer a plan right from the queue wording.
4. **Metric contract.** Freeze the allowed fields and each field's completeness
   rule. Revenue must be net-of-refunds only when that coverage is complete;
   subscriber and affiliate totals require equally explicit sources.
5. **Schedule contract.** Freeze weekly/monthly behavior, time zone, missed-run
   handling, and whether owner/team/external copies share one generated result.
6. **Storage and delivery ceilings.** Approve finite report/config/recipient,
   byte, retention, retry, queue, and global execution ceilings after the cost
   registry is current. This document intentionally supplies no new visible
   customer limit.
7. **Artifact format.** Keep accessible text/email mandatory. PDF remains off
   unless a funded, tested accessible generation and validation path is later
   approved.

## Safe implementation order after the blockers clear

1. Re-audit open PR paths after #2876 and the cost-registry PRs resolve.
2. Add a bounded, versioned report definition and recipient authorization
   schema, including data-registry coverage and erasure behavior.
3. Add the cost-registry line and atomic admission that reserves the complete
   occurrence before query/render/send. Unknown admission refuses before paid
   work.
4. Add exact read/write acknowledgements and a durable occurrence/recipient
   delivery state; uncertain results remain unknown and do not become success.
5. Reuse one bounded data read for every authorized recipient of the same
   report occurrence; never repeat the provider query per recipient.
6. Add the accessible studio flow and plain-language email. Record steps and
   decisions before/after in the product PR.
7. Add RED-first tests for allowance exhaustion, unknown reads and writes,
   incomplete financial coverage, authorization changes immediately before
   send, lost provider responses, duplicate cron invocations, store isolation,
   retention/erasure, and absence of buyer personal data.
8. Require the applicable independent review(s) and nine exact-head workflow
   successes before merge. A documentation review does not approve a later
   product head.

## Verification and accessibility

- Repository evidence only; no provider account, real recipient, production
  data, external contact, or paid IO was used.
- No runtime, test, workflow, reservation document, price, limit, commission,
  flag, gate, or production schedule changed.
- Accessibility: documentation-only, **0 -> 0 steps and 0 -> 0 decisions** for
  a customer. No human usability or PDF/UA result is claimed.
- This audit is a prerequisite map, not a RED, product test, margin
  certification, entitlement, publication, or delivery.
