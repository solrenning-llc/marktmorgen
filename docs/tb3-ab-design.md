# Tests with up to four versions: design (377 [TB3], unit 1)

State (AGENTS.md, VR item 1): **tested in a PR.** Unit 1 is this design and a pure
winner rule, `lib/ab-decision.ts`, held by `tests/tb3-ab-decision.test.ts`. Nothing
here is wired to a page, an automation or the studio, nothing is read from Redis or
Stripe, and nothing switches what a visitor sees. No customer can use a test of
three or four versions yet, and no page says they can.

## 1. What exists today (two versions, the headline test)

Code: `lib/headline-test.ts` (counting, server), `lib/headline-test-rules.ts`
(rules, browser and server), `lib/headline-test-counts.ts` (strict parsing),
`lib/headline-test-atomic.ts` (one Lua script per paid sale),
`lib/headline-test-words.ts` (public words), `lib/sales-page.ts` (the test on a page).

- **Assignment.** A visitor gets one random group number, 0 to 999, in the
  `nl_ab` cookie (90 days, `proxy.ts`). `versionFor(bucket, testId)` mixes the
  group with the test id and takes the result modulo 2, so the same visitor is
  not always in the same half of every test. Where the law asks for consent
  before such a cookie, none is set: the visitor sees version A and is not
  counted. `expectedShareB(testId)` counts the 1,000 groups to know each
  version's real share.
- **Counting.** One Redis hash per test, `nl:ab:<stats>:<product>:<test>`:
  views `va vb`, checkouts opened `ca cb`, paid sales `sa sb`, money `ra rb`,
  the sum of each sale's square `qa qb`, and the start `t0`. A view is one
  `HINCRBY`; a paid sale is added once by the five-minute checkout sweep
  (`lib/checkout-sweep.ts`, `noteTestSales`), only in the store's currency,
  under a 40-day mark `nl:ab:paid:<checkout>`.
- **Deciding.** Worked out on every read, never stored. Paid product: money per
  visitor, each version with `MIN_VIEWS` (200) views and `MIN_SALES` (10) paid
  sales, the test at least `REFUND_DAYS` (14) days old. Free product: sign-ups,
  two-proportion test with `MIN_EXPECTED_SIGNUPS`. The line is an asymptotic
  confidence sequence (`boundary`), valid however often the result is read, at a
  5% chance of a false winner over the whole test. A sample ratio mismatch
  (p < 0.001) or a measure changed mid-test stops any winner.
- **Known gap.** Refunds are **not** subtracted today: the 14 days only wait for
  them. `PAGE_TEST_PAID_WORDS` says so ("The totals are gross payments: refunds
  are not subtracted"). TB3 closes that gap for the new rule.
- **Switching.** After a two-version test is won, the page shows the winner by
  itself until the creator keeps it or ends the test. That behavior is not
  changed by this unit, and is not extended to three or four versions (section 8).

## 2. What changes for three and four versions

| Question | Two versions today | Two to four versions (TB3) |
| --- | --- | --- |
| Measure | Gross money per visitor (paid product) | **Money kept after refunds and disputes** per visitor; checkouts, clicks and opens never decide a paid test |
| Minimum per version | 200 views, 10 paid sales | 200 visitors, **10 sales neither refunded nor disputed at all** (a partial refund keeps its net money but does not count toward the 10) |
| Wait | 14 days from start | 14 days from start, and refunds and disputes subtracted (section 5) |
| Line | `boundary(views)` at 5% | Same curve per pair, at **5% ÷ number of pairs**: 1, 3, 6 pairs |
| Leader | Larger of two | Must clear the line against **every** other version |
| Split check | Chi-square, 1 degree of freedom | Chi-square, k − 1 degrees of freedom, p < 0.001 (10.828, 13.816, 16.266) |
| Currencies | Store's currency only | Mixed currencies refused with a reason, never added |

With two versions the new line is exactly today's (`pairLine(views, 2) ===
boundary(views)`, tested), so a two-version test reads the same.

## 3. Assignment balance for three and four versions (later unit)

- Keep the one cookie and the 1,000 groups; no new cookie, no personal data.
- A test of k versions maps the mixed hash modulo k. For k = 2 the mapping stays
  exactly today's (`% 2`), so running tests do not move visitors.
- The real share of each version is the count of the 1,000 groups that land on it
  (as `expectedShareB` does today); those shares are what `abDecision` receives in
  `shares`, so the split check compares against the real shares, not a rounded 1/k.
- A visitor keeps their version for the cookie's life. Changing the number of
  versions of a running test is refused: it would move visitors between versions
  and mix their counts. The creator ends the test and starts a new one.
- Visitors without consent for the cookie see version A and are not counted, as today.

## 4. The multiple-comparison correction: Bonferroni over every pair

**Choice.** Split the 5% chance of a false winner evenly over every pair of
versions (k(k − 1)/2 pairs) and keep the existing anytime-valid line for each pair.

**Why it holds.** If every pair's line holds (each pair's confidence sequence
contains the true difference), then a version declared ahead of every other really
is ahead of every other. The chance that some pair's line fails is at most the sum
of the pairs' shares, 5%. So the whole test keeps at most a 5% chance of a false
winner, however often it is read.

**Why this one and not a Bayesian rule.**

1. With two versions it is exactly today's rule: no running test changes.
2. It needs no prior. A Bayesian "chance to be best" depends on a prior that the
   creator cannot see or check, and it does not by itself bound false winners
   when the result is read every day.
3. It is easy to say in one sentence: "With 4 versions, each lead must be larger
   than with 2, so that a false winner stays at most 5% likely."
4. It is conservative. Splitting over all pairs (6 for four versions) is
   stricter than splitting over the k − 1 comparisons the leader must win; it
   costs more visitors, never a false winner. The price is measured below.

**What it costs in visitors.** At 8,000 visitors per pair the line is z ≥ 3.13
for two versions, 3.47 for three and 3.67 for four. In the test, a leader at 80
kept sales against 45 (4,000 visitors each, $50 each) wins with two versions and
is "too close" with four. A creator with little traffic should test two versions;
the studio will say so before a test of four starts (section 9).

## 5. Refunds and disputes

- Money kept per version = money paid − money refunded − money disputed, in the
  store's currency. A dispute counts when it is in a state that takes the money
  (`DISPUTE_TAKES` in `lib/retained-revenue.ts`: `needs_response`,
  `under_review`, `lost`), the same set the kept-money report reads. On Stripe a
  dispute is not a refund, so it never reaches the refunded figures by itself.
- An order with such a dispute counts in `disputedOrders`, not in
  `refundedOrders`, and everything it did not keep (the disputed amount and any
  refund given on it) counts in `disputedCents`. A disputed order is not a kept
  sale toward the minimum.
- Spread (variance) uses the sum of the squares of what each order kept
  (`netSquares`). A later unit keeps it atomically: when an order of P is
  refunded R, the square changes from P² to (P − R)² in the same Lua script that
  moves the money, under a mark per refund so it is applied once; when an order
  is disputed, the same script moves its money to the disputed figures and its
  square to the kept remainder, under a mark per dispute. A dispute the creator
  wins later (`won`) gives the money back through the same script, once.
- The rule refuses figures that cannot be true: more refunded and disputed than
  paid (orders or money), more orders than visitors, orders with no money or
  money with no orders (paid, refunded or disputed), squares that cannot come
  from the money (Cauchy–Schwarz bounds). The dispute figures are required: when
  a store's disputes cannot be read, the caller has no figures to give and
  nothing is decided; they are never passed as 0. Unknown is never zero (CX-123
  rule 24).
- **Refund window before a result is final.** No winner before the test has run
  `REFUND_DAYS` (14). A later unit should also decide only on visitors and orders
  older than the window (a "matured" slice: counts kept per day, decided up to
  now − 14 days, refunds as of now), so a refund after day 14 cannot flip an
  already shown result without the screen saying so. Until that slice exists, a
  winner shown on day 15 can still change if many refunds arrive; the screen
  will say "based on sales up to <date>, refunds up to today".

## 6. Ties, uncertainty and the reasons shown

`abDecision` returns `winner` or `no_clear_winner_yet`, always with a reason and
the figures to show (visitors, paid, refunded, disputed, kept, money kept per 100 visitors):

| Reason | When | Plain words (start) |
| --- | --- | --- |
| `invalid` | Figures missing, negative, fractional or not adding up; 1 or 5+ versions | "No result: the figures could not be read." |
| `mixed_currencies` | Two currencies | "No result: the versions' sales are in different currencies (EUR, USD)." |
| `too_few` | A version under 200 visitors or 10 kept sales | "No clear winner yet: there is not enough data." + what each needs |
| `split` | Visitors not split as expected | "No clear winner yet: visitors were not split between the versions as expected" |
| `refund_window` | Under 14 days | "No clear winner yet: the test must run for 14 days so refunds can be counted." |
| `tie` | Exactly equal money per visitor at the top | "No clear winner yet. Version A and Version B brought exactly the same money…" |
| `too_close` | The leader does not clear the line against some version | "No clear winner yet. Version B is ahead after refunds and disputes, but its lead over … is still small enough to be chance." |
| `clear_lead` | Winner | "Version B is the winner. After refunds and disputes, it brought the most money per 100 visitors…" ending "It is not a promise of future sales." |

## 7. Stopping rules

- The line is valid however often the test is read, so there is no fixed end date
  and no penalty for checking daily.
- A test stops only when the creator ends it or keeps a version. The rule never
  stops a test by itself.
- A later unit may add a "no difference worth waiting for" message once the test
  has run long (for example 8 weeks) with every version over the minimums and no
  winner: it says the versions perform about the same, and it is information,
  not a winner.
- A changed product (free ↔ paid), a changed price, a changed number of versions
  or a currency change ends the comparison: the counts no longer measure one thing.

## 8. Never switching by itself in TB3

`abDecision` only reports. Showing a winner to everyone, or stopping a version,
happens only when the creator chooses it, or when the creator explicitly turned on
"switch to the winner automatically" for that test (queue: "eventual mudança
automática explicitamente configurada"). Automations (emails) need the creator's
approval before any send, as today; versions of an email split one send, they do
not multiply the sends allowed by the plan.

## 9. Storage and cost for later units (estimate, to be held in the registries)

No new read or write happens in unit 1 (MR rule: no new reads in unit 1).

- **Storage.** One hash per test, as today. Four versions × (visitors, checkouts,
  paid orders, paid money, refunded orders, refunded money, disputed orders,
  disputed money, net squares) + start ≈ 37 fields, about 750–1,000 bytes. Today's reserve per test is
  `AB_RECORD_BYTES` = 1,024 (`lib/sales-page-store.ts`), taken from the plan's
  storage already counted; measure the four-version record in a test and keep or
  raise it there, inside the plan's own storage, never as extra storage.
- **Writes per view.** Unchanged: one `HINCRBY` per counted view, to its one
  version. Three or four versions do not multiply views, visits or sends.
- **Writes per sale.** Unchanged: one Lua call per paid sale, under its mark.
- **Refunds (new).** Today refunds are read only for stores with license keys
  or reviews (`lib/checkout-sweep.ts`). A store with a running money test would
  join that read; each read is a Stripe list call inside the sweep's existing
  budget (time, three pages per store). It must be entered in
  `tests/plan-cost-registry.ts` and `tests/store-data-registry.ts` in the same PR
  (CX-123 rule 26), with a mark per refund (`nl:ab:refund:<refund id>`, 40 days).
- **Disputes (new).** Read beside the refunds, in the same sweep and budget:
  the Stripe dispute list, only the states in `DISPUTE_TAKES`, with a mark per
  dispute (`nl:ab:dispute:<dispute id>`, 40 days) so it is applied once, and
  entered in the same two registries in the same PR. A store whose disputes
  were not read in full gets no result (`invalid`), never 0 disputes. PayPal
  disputes are not read today (as in `lib/retained-revenue.ts`), so a test on a
  store that sells through PayPal must say so or not decide.
- **Model calls.** None. The rule is arithmetic.
- **Matured slice (section 5).** Day buckets per version would add about 4 × 7
  fields per day kept; capped at the test's 400-day expiry it needs a measured
  bound before it is built.

## 10. Wording rules for the later screen (Acessibilidade)

Unit 1 has no screen: 0 → 0 steps and decisions. For the screen that will show
`abDecision`:

- Every reason is said in words, first, before any number; never only by color,
  icon or position (WCAG 1.4.1). "Winner" and "No clear winner yet" are text.
- Figures in a real table with column headers: visitors, paid orders, refunded,
  disputed, kept, money kept per 100 visitors. Money through `formatMoney`, in the store's
  currency, never mixed.
- Short sentences in plain American English (AX274 3.1.5). Terms explained in
  place: "kept sales" = sales not refunded or disputed; "per 100 visitors".
- No promise, no earnings claim (NE1): the winner sentence always ends with "This
  shows what happened during the test. It is not a promise of future sales."
- The chance of a false winner is said once, as a limit of the rule, never as a
  probability that the creator will earn more.
- Before a test of three or four versions starts, the screen says it needs more
  visitors than a test of two.
- Live updates of the result use a polite live region; no animation that cannot
  be turned off; the action to end or keep a version asks for confirmation and
  can be undone while the test is kept.

Not verified in this unit: any screen, any real store's data, any real assistive
technology test, and the matured slice of section 5.
