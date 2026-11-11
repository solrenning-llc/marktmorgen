# Upstash Redis fixed-plan decision — 325 [IN1]

Evidence read on **6 November 2026**. This is a decision document, not an
account operation. **No account change was made.** No credential, database
identifier, live key, customer record, billing method, supplier term, or
personal data was read or written.

## Decision now

**Do not change the real database yet.** Keep the existing supplier setup
unchanged until a read-only account observation and the application-wide
ceilings below are complete. At current published rates, the repository's
isolated-store PAYG Redis model is cheaper than even the smallest fixed tier
that could hold that store's modeled peak. More importantly, the live
aggregate data size, live peak commands per second, live monthly bandwidth,
read-region count, Prod Pack state, provider-accounted memory overhead, and
number of simultaneous full stores are **unknown, never zero**. A shared fixed
database cannot be selected safely from a one-store calculation.

This recommendation does not change a price, customer limit, commission,
feature flag, sales gate, tax gate, provider account, or production setting.
It does not count a free allowance as zero cost.

## Official sources and retrieval boundary

- [Upstash Redis machine-readable pricing](https://upstash.com/pricing/redis.md),
  official page retrieved 6 November 2026. The page exposes no editorial
  publication date, so the retrieval date is recorded instead of inventing
  one. Its human-readable counterpart is
  <https://upstash.com/pricing/redis>.
- [Auto Upgrade](https://upstash.com/docs/redis/features/auto-upgrade), official
  documentation retrieved 6 November 2026. It says bandwidth can be throttled
  and writes can be rejected at storage limits; when Auto Upgrade is enabled,
  the database instead moves to the next plan.
- [Change Database Plan](https://upstash.com/docs/devops/developer-api/redis/change_plan),
  official API reference retrieved 6 November 2026. It publishes the exact
  fixed-plan identifiers and treats `auto_upgrade` and `prod_pack_enabled` as
  separate billing-affecting fields.
- [Upstash agent resource documentation](https://upstash.com/docs/agent-resources/mcp),
  official page retrieved 6 November 2026. It describes the current Console
  route as Redis database → **Settings**, where the plan, Prod Pack, budget,
  read regions, eviction and Auto Upgrade are managed. It also classifies a
  plan change as destructive and requires a quoted price and confirmation.
- Repository rates and rights: `lib/spend-cost-table.ts`,
  `tests/plan-cost-registry.ts`, `tests/plan-cost-model.ts`,
  `lib/store-data-rules.ts`, and `tests/store-data-registry.ts` at base
  `b8c951f7e5b0492a8cd1e9f4437125d2ea6d747b`.

No authenticated Console page or live supplier API was opened. Public sources
do not expose the final confirmation dialog's exact current label, and this
document does not guess it.

## Published fixed tiers

The amounts below are the base database fee with zero read regions and without
Prod Pack, tax, currency conversion, or card/remittance cost. A read region is
additive. Fixed plans have unlimited command count billing, but still have
data, bandwidth, throughput, request, and record limits.

| Plan | Base/month | Each read region/month | Max data | Bandwidth/month | Commands/second |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed 250 MB | $10 | $5 | 250 MB | 50 GB | 10,000 |
| Fixed 1 GB | $20 | $10 | 1 GB | 100 GB | 10,000 |
| Fixed 5 GB | $100 | $50 | 5 GB | 500 GB | 10,000 |
| Fixed 10 GB | $200 | $100 | 10 GB | 1 TB | 10,000 |
| Fixed 50 GB | $400 | $200 | 50 GB | 5 TB | 10,000 |
| Fixed 100 GB | $800 | $400 | 100 GB | 10 TB | 16,000 |
| Fixed 500 GB | $1,500 | $750 | 500 GB | 20 TB | 16,000 |

The published zero-read-region base totals for twelve worst months are $120,
$240, $1,200, $2,400, $4,800, $9,600, and $18,000 respectively. The complete
fixed cost is:

`12 × (base monthly fee + read-region count × per-region fee + Prod Pack fee) + tax + payment/FX cost`.

Every term not proven from the real account remains unknown; it is never
substituted with zero. Upstash currently publishes Prod Pack as another
$200/month per database, but this document neither selects nor changes it.

## Current PAYG model, by plan and interval

The repository deliberately prices PAYG Redis without taking the shared first
1 GB of storage or first 200 GB of bandwidth as a per-store credit. That is the
safe marginal reading when many stores share one database. To bound Redis's
contribution to the full plan model, the same model was evaluated three times
with only one canonical Upstash rate set to zero: commands, transferred bytes,
then GB-months. Each difference is a separate rate sensitivity. They are **not
disjoint supplier components** because zeroing a rate can change which
competing operation a `Math.max` selects and therefore change its other
resource costs. Their displayed total is a **conservative sum of separate rate
sensitivities**, not exact attribution. No product constant was changed.

Current canonical rates are $0.20/100,000 commands, $0.03/GB transferred past
the shared allowance, and $0.25/GB-month stored past the shared allowance.

| Customer plan | Interval | Command-rate sensitivity | Transfer-rate sensitivity | Storage-rate sensitivity | Conservative sensitivity sum |
| --- | --- | ---: | ---: | ---: | ---: |
| Store | month | $3.208618 | $0.659180 | $0.037784 | **$3.905582** |
| Store | 12 worst months | $38.503413 | $7.910156 | $0.453409 | **$46.866978** |
| Studio | month | $4.990522 | $0.718050 | $0.110816 | **$5.819388** |
| Studio | 12 worst months | $59.886261 | $8.616606 | $1.329794 | **$69.832660** |
| Scale | month | $8.203842 | $0.820725 | $0.249999 | **$9.274567** |
| Scale | 12 worst months | $98.446101 | $9.848706 | $2.999992 | **$111.294799** |

These sensitivities bound one isolated store using all modeled rights. They
are not its complete plan cost, an invoice forecast, a company total, a 60%
margin certification, or an exact attribution of commands, transfer and
storage. In particular, a dollar sensitivity cannot establish either a
monthly command count or a peak-per-second bound.

## Fixed-plan comparison for one isolated full store

The repository's logical peak data figures are 0.312558 GB for Store,
0.939010 GB for Studio, and 2.722817 GB for Scale. They include each plan's
data room plus records kept outside it at their simultaneous peak. The backup
study's conservative local-Redis conversion reading of 1.7 times logical
bytes would make them 0.531348 GB, 1.596316 GB, and 4.628789 GB. Upstash's
public page does not establish that this conversion is its billed max-data
metric, so these remain sizing evidence, not a provider guarantee.

| Customer plan | PAYG month | PAYG 12 months | Smallest conditional fixed tier | Fixed month | Fixed 12 months | Result |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Store | $3.905582 | $46.866978 | Fixed 1 GB | $20 | $240 | PAYG is cheaper |
| Studio | $5.819388 | $69.832660 | Fixed 5 GB | $100 | $1,200 | PAYG is cheaper |
| Scale | $9.274567 | $111.294799 | Fixed 5 GB | $100 | $1,200 | PAYG is cheaper |

“Conditional” means zero read regions, no Prod Pack, no supplier tax/FX cost,
one full store in the entire database, the 1.7 conversion reading holding, and
throughput/bandwidth staying inside the tier. The real shared database does
not satisfy that evidence set today. Therefore none of these rows authorizes
a plan change.

## Automatic ceilings required before any fixed-plan switch

Two application-wide guards are prerequisites. Provider Auto Upgrade is not a
substitute for them because it can increase the monthly fee.

1. **Throughput ceiling.** Measure and bind the maximum commands of every
   operation, including the admission counter itself, retries, scripts and
   replication. Before the first paid command, atomically reserve that entire
   amount in a global one-second window. Refuse before operation when the
   reservation would reach the selected tier's commands/second. The usable
   ceiling is strictly below the provider maximum: `provider maximum − largest
   complete operation`. Unknown, partial, inherited, late or failed counter
   reads must reject, not grant work. The largest complete operation and the
   live peak commands per second are currently unknown, so no safe numeric
   throughput ceiling is claimed.
2. **Data-size ceiling.** Measure the provider-accounted bytes of every key,
   value, index, allocator overhead and replica. Before each write, reserve
   its largest retained provider bytes against one global database total.
   Refuse before the write when it would reach `plan max data − largest atomic
   write`. Unknown measurement, cleanup or acknowledgement must keep the
   reservation and reject. Existing per-store rooms do not cap the sum of all
   stores. The live aggregate data size and provider conversion are currently
   unknown, so no safe numeric data-size ceiling is claimed.

The same pre-spend rule applies to bandwidth. Until all three guards are
implemented, measured with synthetic concurrency and loss, independently
reviewed and funded, a fixed plan is not selectable. **Auto Upgrade must remain
disabled** in any future fixed-plan proposal unless the owner separately
approves the next tier's complete worst cost; otherwise the supplier can move
the database to a dearer tier when storage or bandwidth is reached.

## Console runbook — stop before billing confirmation

This is the furthest exact public documentation permits without entering the
real account:

1. Open the Upstash Console and choose **Redis**.
2. Click the intended database name to open its database detail page.
3. Open **Settings**.
4. In the plan control, choose **Change Plan** and select the reviewed fixed
   tier. Do not infer the tier from a marketing card.
5. In **Configuration / Auto Upgrade**, keep **Auto Upgrade** disabled. Verify
   the displayed read regions and **Prod Pack** state; do not change either.
6. Compare the Console's complete quote with this document, including every
   read-region charge, Prod Pack, tax and currency/payment amount.
7. **Stop before the final confirm or confirmation action.** Capture no
   credential or personal data. Obtain the owner's written approval of the
   exact quote and separately verify that the throughput ceiling and data-size
   ceiling were deployed and tested before any paid switch.

The official public pages do not publish the final Console button's current
label. That label is therefore an owner-observed prerequisite, not an invented
instruction. If the current Console does not show **Settings**, **Change
Plan**, **Auto Upgrade**, and **Prod Pack** as documented, stop and update this
runbook from a read-only observation; do not click a substitute.

## Owner decision packet

Current recommendation: **stay on the existing setup and do not perform a
fixed-plan change**. To reconsider, the owner must supply a read-only snapshot
of the database's plan, data size, 30-day bandwidth, peak commands/second,
read-region count, Prod Pack and exact quoted total. The application must first
have the global pre-command and pre-write ceilings above. No supplier contact,
term acceptance, payment, migration, deletion, or production write is part of
this item.
