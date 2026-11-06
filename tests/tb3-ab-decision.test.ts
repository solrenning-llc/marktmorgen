/**
 * The winner rule for a test of two to four versions (377 [TB3], unit 1;
 * docs/tb3-ab-design.md). Pure: nothing is read, written or switched. Checked:
 *
 *   - with two versions the line is exactly the headline test's line
 *     (lib/headline-test-rules.ts, boundary), so nothing running today changes;
 *   - with three or four versions the line is stricter (Bonferroni over every
 *     pair), so a lead that wins between two versions is "too close" among four;
 *   - money is net of refunds: refunds can turn the leader into the loser;
 *   - each version needs MIN_VIEWS visitors and MIN_SALES sales that were not
 *     refunded, and the test must have run REFUND_DAYS days;
 *   - an exact tie, a split that is off, mixed currencies and figures that
 *     do not add up are each named, never read as a winner;
 *   - the words say what was measured, in plain English, and promise nothing.
 */
import {
  AB_MAX_VERSIONS,
  abDecision,
  falseWinnerShare,
  pairLine,
  type AbInput,
  type AbVersion,
} from "@/lib/ab-decision";
import { boundary, MIN_SALES, MIN_VIEWS, REFUND_DAYS } from "@/lib/headline-test-rules";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);
const PRICE = 5_000;

/** A version whose kept sales are all at PRICE, with `refunded` more sales refunded in full. */
const v = (id: string, visitors: number, kept: number, refunded = 0, currency = "usd"): AbVersion => ({
  id,
  visitors,
  paidOrders: kept + refunded,
  paidCents: (kept + refunded) * PRICE,
  refundedOrders: refunded,
  refundedCents: refunded * PRICE,
  netSquares: kept * PRICE * PRICE,
  currency,
});

const input = (versions: AbVersion[], over: Partial<AbInput> = {}): AbInput => ({
  versions,
  startedAt: NOW - 30 * DAY,
  now: NOW,
  ...over,
});

part("the line: two versions keep today's line, more versions a stricter one");
for (const views of [400, 2_000, 8_000, 50_000]) {
  is(`two versions at ${views} views: the headline test's line`, pairLine(views, 2), boundary(views));
}
is("the false-winner share is split over every pair: 2 versions, 1 pair", falseWinnerShare(2), 0.05);
is("3 versions, 3 pairs", falseWinnerShare(3), 0.05 / 3);
is("4 versions, 6 pairs", falseWinnerShare(4), 0.05 / 6);
is("a stricter line with 4 versions than with 2", pairLine(8_000, 4) > pairLine(8_000, 2), true);
is("at most four versions", AB_MAX_VERSIONS, 4);

part("two versions: a clear lead wins, figures net of refunds");
{
  const out = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 80)]));
  is("B wins", out.result, "winner");
  is("named B", out.winner, "b");
  is("reason", out.reason, "clear_lead");
  is("money per 100 visitors, net, in cents", out.figures?.map((f) => f.netPer100Cents), [5_000, 10_000]);
  is(
    "words",
    out.words,
    "Version B is the winner. After refunds, it brought the most money per 100 visitors: $100, against $50 for Version A. Its lead over every other version is large enough that chance alone is unlikely: the rule allows at most a 5% chance of a false winner over the whole test. This shows what happened during the test. It is not a promise of future sales.",
  );
  is("comparisons shown with their line", out.comparisons?.map((c) => c.against), ["a"]);
  is("each comparison clears its line", out.comparisons?.every((c) => c.z >= c.line), true);
}

part("refunds turn the leader into the loser");
{
  // A sold more (90 against 80), but refunded 50 of them in full.
  const a = v("a", 4_000, 40, 50);
  const b = v("b", 4_000, 80);
  is("A had more paid orders before refunds", a.paidOrders > b.paidOrders, true);
  const out = abDecision(input([a, b]));
  is("B wins on money kept", out.winner, "b");
  is("A's figures say what was refunded", out.figures?.[0], {
    id: "a",
    label: "Version A",
    visitors: 4_000,
    paidOrders: 90,
    refundedOrders: 50,
    keptOrders: 40,
    paidCents: 450_000,
    refundedCents: 250_000,
    netCents: 200_000,
    netPer100Cents: 5_000,
    currency: "usd",
  });
  // A partial refund lowers money but the sale stays a sale; it does not count toward the minimum.
  const partial: AbVersion = { id: "c", visitors: 4_000, paidOrders: 2, paidCents: 10_000, refundedOrders: 1, refundedCents: 2_000, netSquares: 5_000 ** 2 + 3_000 ** 2, currency: "usd" };
  const out2 = abDecision(input([partial, v("d", 4_000, 80)]));
  is("a partly refunded sale is not a kept sale for the minimum", out2.reason, "too_few");
  is("its net is the money minus the refund", out2.figures?.[0].netCents, 8_000);
}

part("four versions: stricter line, named laggards");
{
  const clear = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 90), v("c", 4_000, 40), v("d", 4_000, 40)]));
  is("a large lead over all three wins", [clear.result, clear.winner], ["winner", "b"]);
  is("three comparisons", clear.comparisons?.map((c) => c.against), ["a", "c", "d"]);

  const two = abDecision(input([v("a", 4_000, 45), v("b", 4_000, 80)]));
  is("between two versions, 80 against 45 wins", two.winner, "b");
  const four = abDecision(input([v("a", 4_000, 45), v("b", 4_000, 80), v("c", 4_000, 45), v("d", 4_000, 45)]));
  is("among four, the same lead is too close", [four.result, four.winner, four.reason], ["no_clear_winner_yet", null, "too_close"]);
  is("the versions still too close are named", four.close, ["a", "c", "d"]);
  is(
    "words",
    four.words,
    "No clear winner yet. Version B is ahead after refunds, but its lead over Version A, Version C and Version D is still small enough to be chance. With 4 versions, each lead must be larger than with 2, so that a false winner stays at most 5% likely.",
  );

  const mixed = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 90), v("c", 4_000, 80), v("d", 4_000, 40)]));
  is("a clear lead over two, not over the third", [mixed.reason, mixed.close], ["too_close", ["c"]]);
}

part("ties");
{
  const tie = abDecision(input([v("a", 4_000, 80), v("b", 4_000, 80)]));
  is("an exact tie has no winner", [tie.result, tie.reason, tie.tied], ["no_clear_winner_yet", "tie", ["a", "b"]]);
  is(
    "words",
    tie.words,
    "No clear winner yet. Version A and Version B brought exactly the same money per 100 visitors after refunds: $100.",
  );
  const topTie = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 90), v("c", 4_000, 90), v("d", 4_000, 40)]));
  is("a tie at the top among four names the two tied", [topTie.reason, topTie.tied], ["tie", ["b", "c"]]);
}

part("tiny samples");
{
  const out = abDecision(input([v("a", 150, 40), v("b", 4_000, 9)]));
  is("too few", [out.result, out.reason], ["no_clear_winner_yet", "too_few"]);
  is("what each version still needs", out.short, [
    { id: "a", visitors: MIN_VIEWS - 150, sales: 0 },
    { id: "b", visitors: 0, sales: MIN_SALES - 9 },
  ]);
  is(
    "words",
    out.words,
    `No clear winner yet: there is not enough data. Each version needs at least ${MIN_VIEWS} visitors and ${MIN_SALES} sales that were not refunded. Version A needs 50 more visitors. Version B needs 1 more sale.`,
  );
  const none = abDecision(input([v("a", 0, 0), v("b", 0, 0)]));
  is("nothing yet is too few, not a tie", none.reason, "too_few");
  const refundedAway = abDecision(input([v("a", 4_000, 9, 30), v("b", 4_000, 80)]));
  is("sales refunded in full do not count toward the minimum", refundedAway.reason, "too_few");
}

part("refund window");
{
  const young = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 80)], { startedAt: NOW - 10 * DAY }));
  is("a clear lead still waits for refunds", [young.result, young.reason], ["no_clear_winner_yet", "refund_window"]);
  is("days left", young.daysLeft, REFUND_DAYS - 10);
  is(
    "words",
    young.words,
    `No clear winner yet: the test must run for ${REFUND_DAYS} days so refunds can be counted. 4 days to go.`,
  );
  const exact = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 80)], { startedAt: NOW - REFUND_DAYS * DAY }));
  is("decided once the window has passed", exact.winner, "b");
}

part("split that is off");
{
  const out = abDecision(input([v("a", 4_000, 40), v("b", 3_500, 80)]));
  is("no winner when visitors are not split as expected", [out.result, out.reason], ["no_clear_winner_yet", "split"]);
  const shared = abDecision(input([v("a", 4_000, 40), v("b", 3_500, 70)], { shares: [4 / 7.5, 3.5 / 7.5] }));
  is("the expected shares are used when given", shared.reason === "split", false);
}

part("refused: mixed currencies, bad figures, wrong number of versions");
{
  const mixed = abDecision(input([v("a", 4_000, 40), v("b", 4_000, 80, 0, "eur")]));
  is("mixed currencies are refused", [mixed.result, mixed.reason, mixed.figures], ["no_clear_winner_yet", "mixed_currencies", null]);
  is(
    "words",
    mixed.words,
    "No result: the versions' sales are in different currencies (EUR, USD). Money in two currencies cannot be compared, so nothing is decided.",
  );
  const bad: [string, AbInput][] = [
    ["one version", input([v("a", 4_000, 40)])],
    ["five versions", input([v("a", 4_000, 40), v("b", 4_000, 40), v("c", 4_000, 40), v("d", 4_000, 40), v("e", 4_000, 40)])],
    ["repeated id", input([v("a", 4_000, 40), v("a", 4_000, 80)])],
    ["unknown id", input([v("a", 4_000, 40), v("x", 4_000, 80)])],
    ["more refunded than paid", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), refundedCents: 500_000 }])],
    ["more refunded orders than paid", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), refundedOrders: 81 }])],
    ["more orders than visitors", input([v("a", 4_000, 40), v("b", 60, 80)])],
    ["negative", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), visitors: -1 }])],
    ["fraction", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), paidCents: 400_000.5 }])],
    ["missing squares", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), netSquares: 0 }])],
    ["squares too small for the money", input([v("a", 4_000, 40), { ...v("b", 4_000, 80), netSquares: 1 }])],
    ["squares on nothing kept", input([v("a", 4_000, 40), { ...v("b", 4_000, 0), netSquares: 9 }])],
    ["not a currency", input([v("a", 4_000, 40, 0, "US$"), v("b", 4_000, 80, 0, "US$")])],
    ["start in the future", input([v("a", 4_000, 40), v("b", 4_000, 80)], { startedAt: NOW + DAY })],
    ["shares not adding to one", input([v("a", 4_000, 40), v("b", 4_000, 80)], { shares: [0.5, 0.6] })],
    ["shares of the wrong length", input([v("a", 4_000, 40), v("b", 4_000, 80)], { shares: [1] })],
    ["a zero share", input([v("a", 4_000, 40), v("b", 4_000, 80)], { shares: [1, 0] })],
  ];
  for (const [what, figures] of bad) {
    const out = abDecision(figures);
    is(`${what}: refused, no winner`, [out.result, out.winner, out.reason], ["no_clear_winner_yet", null, "invalid"]);
  }
  is(
    "words when figures cannot be read",
    abDecision(bad[4][1]).words,
    "No result: the figures could not be read. Nothing is decided from them.",
  );
  is("not an object is refused", abDecision(null as unknown as AbInput).reason, "invalid");
}

part("pure: the input is not changed, and nothing is switched");
{
  const figures = input([v("a", 4_000, 40), v("b", 4_000, 80)]);
  const before = JSON.stringify(figures);
  abDecision(figures);
  is("input unchanged", JSON.stringify(figures), before);
  const out = abDecision(figures);
  is("the verdict only reports: nothing to switch", "switch" in out || "apply" in out, false);
}

part("plain words: no promise, no guarantee");
{
  const samples = [
    abDecision(input([v("a", 4_000, 40), v("b", 4_000, 80)])).words,
    abDecision(input([v("a", 4_000, 45), v("b", 4_000, 80), v("c", 4_000, 45), v("d", 4_000, 45)])).words,
    abDecision(input([v("a", 150, 40), v("b", 4_000, 9)])).words,
  ];
  for (const words of samples) {
    is(`no promise words: ${words.slice(0, 30)}…`, /\b(guarantee|guaranteed|will (sell|earn|make)|proven|certain)\b/i.test(words), false);
  }
}

done();
