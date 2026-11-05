/**
 * 632 [AA2] (i), unit 6: ad versions are compared only once measured, a
 * leader only with a clear margin, the budget moves a step a day, and the
 * campaign's daily budget never changes.
 */
import { MIN_SALES_EACH, SHIFT_POINTS, WINNER_MOST, creativeTest, zBetween, type Version } from "@/lib/ad-creative-test-rules";
import { done, is, part } from "./check";

const v = (id: string, spentCents: number, sales: number | null, sharePercent = 50): Version => ({ id, spentCents, sales, sharePercent });
const sum = (r: ReturnType<typeof creativeTest>) => (r.ok ? [r.shares.reduce((s, x) => s + x.sharePercent, 0), r.shares.reduce((s, x) => s + x.dailyCents, 0)] : null);

part("What it takes");
is("two to six versions", [creativeTest(1000, [v("A", 0, 0, 100)]), creativeTest(1000, Array.from({ length: 7 }, (_, i) => v(`V${i}`, 0, 0, i ? 14 : 16)))].map((r) => (r.ok ? "ok" : r.error)), ["count", "count"]);
is("each version once, named", [creativeTest(1000, [v("A", 0, 0), v("A", 0, 0)]), creativeTest(1000, [v("", 0, 0), v("B", 0, 0)])].map((r) => (r.ok ? "ok" : r.error)), ["ids", "ids"]);
is("shares in whole percents adding up to 100", [creativeTest(1000, [v("A", 0, 0, 60), v("B", 0, 0, 60)]), creativeTest(1000, [v("A", 0, 0, 50.5), v("B", 0, 0, 49.5)])].map((r) => (r.ok ? "ok" : r.error)), ["shares", "shares"]);
is("a daily budget that can be split", creativeTest(1, [v("A", 0, 0), v("B", 0, 0)]).ok, false);

part("Nothing said before it is measured");
const unknown = creativeTest(10_000, [v("A", 50_000, 40), v("B", 50_000, null)]);
is("a version not measured: learning, never read as no sale", unknown.ok && [unknown.state, unknown.leader], ["learning", null]);
const few = creativeTest(10_000, [v("A", 5_000, 30), v("B", 5_000, MIN_SALES_EACH - 1)]);
is(`fewer than ${MIN_SALES_EACH} sales on one: learning, even if the other looks far ahead`, few.ok && [few.state, few.leader], ["learning", null]);
is("it says why, in plain words", few.ok && few.says, `Still learning: each version needs at least ${MIN_SALES_EACH} sales after refunds before any is said to sell more.`);
const close = creativeTest(10_000, [v("A", 50_000, 22), v("B", 50_000, 20)]);
is("measured but close: no clear difference, no leader", close.ok && [close.state, close.leader], ["no_difference", null]);

part("A leader only with a clear margin");
is("the margin is in standard errors of the two rates", Math.round(zBetween({ sales: 40, spentCents: 10_000 }, { sales: 10, spentCents: 10_000 }) * 100) / 100, 4.24);
const lead = creativeTest(10_000, [v("A", 10_000, 10), v("B", 10_000, 40)]);
is("B sells clearly more per dollar: the leader", lead.ok && [lead.state, lead.leader], ["leader", "B"]);
is("it says what was measured, with the counts, and predicts nothing", lead.ok && lead.says, "Version B sells more per dollar after refunds: 40 sales for $100.00, against 10 for $100.00 for the next. It gets more of the budget, a step a day.");
is(`the budget moves ${SHIFT_POINTS} points a day`, lead.ok && lead.shares.map((s) => [s.id, s.sharePercent]), [["A", 30], ["B", 70]]);
const capped = creativeTest(10_000, [v("A", 10_000, 10, 25), v("B", 10_000, 40, 75)]);
is(`never past ${WINNER_MOST}% for the leader, so the others still run`, capped.ok && capped.shares.map((s) => s.sharePercent), [20, 80]);
const already = creativeTest(10_000, [v("A", 10_000, 10, 20), v("B", 10_000, 40, 80)]);
is("at the most already: unchanged", already.ok && already.shares.map((s) => s.sharePercent), [20, 80]);
const three = creativeTest(9_999, [v("A", 10_000, 10, 34), v("B", 10_000, 60, 33), v("C", 10_000, 12, 33)]);
is("the others give up their shares in proportion", three.ok && three.shares.map((s) => s.sharePercent), [24, 53, 23]);
const notAll = creativeTest(10_000, [v("A", 10_000, 10, 34), v("B", 10_000, 40, 33), v("C", 10_000, 36, 33)]);
is("ahead of one but not of every other: no leader", notAll.ok && [notAll.state, notAll.leader], ["no_difference", null]);

part("Back toward equal when nothing is clear");
const drift = creativeTest(10_000, [v("A", 50_000, 22, 80), v("B", 50_000, 20, 20)]);
is("a step a day back toward equal shares", drift.ok && drift.shares.map((s) => s.sharePercent), [60, 40]);
const drift3 = creativeTest(10_000, [v("A", 50_000, 22, 80), v("B", 50_000, 20, 10), v("C", 50_000, 21, 10)]);
is("three versions: every share the same part of the way, still 100% in all", drift3.ok && [drift3.shares.map((s) => s.sharePercent), drift3.shares.reduce((t, s) => t + s.sharePercent, 0)], [[60, 20, 20], 100]);

part("The campaign's daily budget never changes");
for (const [name, r] of [["learning", few], ["no difference", close], ["leader", lead], ["three", three], ["drift", drift], ["drift of three", drift3]] as const) {
  is(`${name}: shares add up to 100% and to exactly the daily budget`, sum(r), [100, name === "three" ? 9_999 : 10_000]);
}
let seed = 11;
const rand = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n);
let off = 0;
let jump = 0;
for (let round = 0; round < 500; round += 1) {
  const n = 2 + rand(5);
  const cuts = Array.from({ length: n - 1 }, () => rand(101)).sort((a, b) => a - b);
  const shares = [...cuts, 100].map((c, i) => c - (i ? cuts[i - 1] : 0));
  const list = shares.map((s, i) => v(`V${i}`, 1_000 + rand(100_000), rand(8) ? rand(80) : null, s));
  const daily = n + rand(500_000);
  const r = creativeTest(daily, list);
  if (!r.ok) continue;
  const [p, c] = sum(r)!;
  if (p !== 100 || c !== daily) off += 1;
  if (r.shares.some((s, i) => Math.abs(s.sharePercent - list[i].sharePercent) > SHIFT_POINTS + 1)) jump += 1;
}
is("random cases: always 100% and exactly the daily budget", off, 0);
is("random cases: no share moves more than a step a day (rounding aside)", jump, 0);

done();
