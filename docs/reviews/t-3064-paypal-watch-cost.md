# T review: PayPal watch list-read accounting, #3064

Subject `b7ac83aef7897a1f7d5b531ecf1a5ca736792314`, tree
`bda7a3d810d06ecd2b3d497975321e0a43412aba`. Three-file delta read completely.
Requested by C4-1319; claim 6709758997 and accepted channel reservation
bde1c274/f8d987a8 preceded source/diff/test work. November 7, 2026.

## Proposed MEDIUM: the new per-store-run/month ceiling assumes unique SCAN results

`tests/plan-cost-registry.ts:1619` newly says a store is swept at most once per
cron run, deriving 2 list reads per store per run and 18,432 per billing month.
The 2 reads are correct for **one invocation** of watchPayPal, not necessarily
one store in the complete checkout sweep. `sweepCheckouts` calls `storesAfter`
until the cursor ends; neither function deduplicates store ids across pages.
`lib/store.ts:1394-1397` already warns that one store can be seen twice.

Independent proof `tests/t-3064-duplicate-scan.proof.ts` runs the real
sweepCheckouts → sweepStore → sweepPayPal → watchPayPal chain, with one actual
synthetic store, empty PayPal lists and no substituted source functions.
Only two finite SCAN reply pages are injected after actual MemoryRedis dispatch:
cursor 0 → 1 with owner key K, cursor 1 → 0 with that same K. The owner GETs and
all watch-list reads run normally. The deadline stays live; no infinite cursor.

| Scenario | SCAN pages | Store visits | Actual two-list reads |
| --- | ---: | ---: | ---: |
| Unique-key control | 1 | 1 | 2 |
| Repeated key across finite pages | 2 | 2, same store | 4 |

Control assertion passes; asserting the new per-store-run ceiling fails.
Exactly the same result occurs with the pre-PR runtime/registry graph: duplication
is **inherited behavior**, while the unsupported once-per-run/month bound is
new in this accounting line. Base declaration is absent; the probe explicitly
labels 2 as the proposed head contract when comparing the old execution.
Each two-scenario probe uses 52 MemoryRedis dispatches and zero HTTP calls.
No paid provider, real Redis or production duplicate-frequency trace was used.

Redis's official [SCAN guarantees](https://redis.io/docs/latest/commands/scan/),
read November 7, 2026, explicitly permit duplicate elements during an iteration
and assign handling to the application. The retrieved page gives no publication
date; access date is not represented as a publication date. This was one focused
primary-document check, not a provider-price research sweep.

The arithmetic 2×288×32=18,432 is correct **if** each store is visited once;
that condition is not enforced by the cited caller. The probe does not measure
a month's charges, prove any dollar loss, repeated payments, infinite work,
or authorize a commercial limit change. The existing 25-per-list bound is
unchanged and holds per invocation. The author explicitly leaves per-order
commands and the dollar figure unknown; that qualification should remain.

Disposition: do not certify 18,432 as an enforced per-store-month ceiling from
this caller. Either document the per-visit figure and leave the full repetition
bound unknown, or prove a reviewed per-store-per-run guard before deriving it.
This is a proposed MEDIUM accounting finding, for coordinator classification
and independent R2 execution before any corrective source change under rule 30.
T has changed no author source, registry value, allowance, price or runtime IO.

## Executed controls and validation

The final permanent test `be623a43828d5390f4ed82d8d2b74467cad05215` was unchanged
between both executions: final graph with only paypal-sales and plan-cost-registry
redirected to exact pre-PR a0ea276a gives 18 checks / 11 failures; head gives 18/18.
The author's original RED f748ce62 has earlier test blob ac663e54; the last commit
narrows the no-PayPal control to its two lists. It is **not** called byte-identical
to the final test. Our same-final-test comparison preserves all final assertions.

| Current permanent group | Passed | MemoryRedis | Synthetic HTTP mocks |
| --- | ---: | ---: | ---: |
| paypal-watch-cost | 18 | 229 | 0 |
| plan-cost-registry | 24 | 0 | 0 |
| paypal-sales | 67 | 322 | 42 |
| platform-us-english | 42 | 0 | 0 |
| Total | 151 | 551 | 42 |

The separate diagnostic remains failing by design (one control PASS, one ceiling
assertion FAIL); it is not included in the 151 passing checks. The probe was
adjusted only to make the absent base registry declaration explicit, then run on
both graphs. This does not turn an observational probe into a GREEN checker.

Runner `scripts/t-review-3064.mjs` requires this exact checkout SHA and unchanged
subject source. It admits only listed filenames, runs serial children, limits
MemoryRedis commands before dispatch to 20,000 per child, synthetic fetch to 100,
child time to 120 seconds, heap to 512 MiB and captured output to 256 KiB. Default
fetch and node HTTP(S) request/get refuse real network; mocks are test-supplied.
There is no claimed case-count cap. No actual provider call was made.

Actual tsconfig ES2017 / strict / Bundler / noEmit, two roots (permanent test and
independent probe), 502 non-declaration sources, zero diagnostics and emit, 1,024
MiB type-process heap. Types were rerun after the probe's namespace-import delta.
ESLint on all three changed files plus runner/probe: exit 0. Runner syntax and
subject diff whitespace checks pass. Before own artifacts, scanner: 4,280 tracked
files / zero findings; final tracked count and own-artifact diff are in receipt.
Installed dependencies exactly match this lock: TypeScript 5.9.3, esbuild 0.28.2,
ESLint 9.39.5, eslint-config-next 16.4.2; Node 24.22.1, no installation.

Read the cron's actual five-minute schedule and the single sweepCheckouts call in
app/api/cron/mail/route.ts; no scheduled-job execution or real-provider timing test.
No Next build, browser, screen-reader, full PayPal review, second financial approval,
global cost coverage or profitability certification. No author ref/CI/queue/merge.
C2's regional-rate sweep remains separate; no rate constant was edited by T.

## Reproduction

Copy runner and probe into exact subject checkout above; the proof branch adds
three paths and is not itself that checkout. Keep exact lock dependencies.

```sh
node scripts/t-review-3064.mjs red paypal-watch-cost.test.ts
node scripts/t-review-3064.mjs head paypal-watch-cost.test.ts plan-cost-registry.test.ts paypal-sales.test.ts platform-us-english.test.ts
node scripts/t-review-3064.mjs red t-3064-duplicate-scan.proof.ts
node scripts/t-review-3064.mjs head t-3064-duplicate-scan.proof.ts
```

The first and both diagnostic commands intentionally exit 1; the permanent head
groups exit 0. Corrective classification/ownership remains with the coordinator.
