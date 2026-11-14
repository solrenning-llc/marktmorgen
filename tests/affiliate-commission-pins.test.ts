/**
 * Pins what an affiliate earns on a sale, before and after a refund (lib/affiliates.ts settleLine, lib/affiliate-setting.ts
 * commissionOn): the share is taken of what was paid before tax, in whole cents rounded down, and a partial refund
 * takes the same part off that base. Until now one partial refund was pinned (tests/offer-journeys.test.ts); these pin
 * the rounding, the tax share of a refund, a refund larger than the sale, a sale of nothing and an own purchase, and that
 * the share never grows as more is given back. Pure values only.
 */
import { settleLine, type Referral } from "@/lib/affiliates";
import { commissionOn } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

const sale = (over: Partial<Referral> = {}): Referral =>
  ({ ref: "cs_pinsAffiliate", pi: "pi_pinsAffiliate", aff: "aff01", at: 1_800_000_000, product: "p1", title: "Course", base: 1_000, total: 1_200, currency: "usd", rate: 50, self: false, ...over }) as Referral;
const view = (r: ReturnType<typeof settleLine>) => [r.refunded, r.commission, r.status];

part("commissionOn: a percentage in whole cents, rounded down");
is("30% of $9.99 is 299 cents, never 300", commissionOn(999, 30), 299);
is("50% of one cent is nothing", commissionOn(1, 50), 0);
is("nothing paid or a negative amount earns nothing", [commissionOn(0, 30), commissionOn(-5, 30)], [0, 0]);
is("0% or a negative share earns nothing", [commissionOn(1_000, 0), commissionOn(1_000, -10)], [0, 0]);
is("100% is the whole base", commissionOn(4_321, 100), 4_321);
{
  // Every whole share from 1% to 100% on every base up to $20.00, against integer arithmetic: no float error ever
  // lands a cent below (or above) the exact floor.
  let wrong = 0;
  for (let rate = 1; rate <= 100; rate += 1) for (let base = 1; base <= 2_000; base += 1) if (commissionOn(base, rate) !== Math.trunc((base * rate - ((base * rate) % 100)) / 100)) wrong += 1;
  is("whole shares on 2,000 bases match integer arithmetic exactly", wrong, 0);
}

part("settleLine: a sale as it stands after a refund");
is("no refund: earned on the base before tax", view(settleLine(sale(), 0)), [0, 500, "earned"]);
is("a third given back (tax included): two thirds of the base, 667, earns 333", view(settleLine(sale(), 400)), [400, 333, "partly refunded"]);
is("only the tax's worth given back still takes its share off the base", view(settleLine(sale(), 200)), [200, 416, "partly refunded"]);
is("all given back: nothing earned", view(settleLine(sale(), 1_200)), [1_200, 0, "refunded"]);
is("more than the sale given back counts as the whole sale", view(settleLine(sale(), 5_000)), [1_200, 0, "refunded"]);
is("a negative refund reads as none", view(settleLine(sale(), -50)), [0, 500, "earned"]);
is("an own purchase earns nothing, whatever the refund", [view(settleLine(sale({ self: true }), 0)), view(settleLine(sale({ self: true }), 400))], [[0, 0, "own purchase"], [400, 0, "own purchase"]]);
is("a sale of nothing earns nothing and is never 'refunded'", view(settleLine(sale({ base: 0, total: 0 }), 0)), [0, 0, "earned"]);
is("a zero-decimal sale (¥) keeps whole units", view(settleLine(sale({ base: 5_000, total: 5_500, currency: "jpy", rate: 30 }), 1_100)), [1_100, 1_200, "partly refunded"]);
{
  // The share never grows as more of the sale is given back.
  let grew = 0;
  let before = Number.POSITIVE_INFINITY;
  for (let back = 0; back <= 1_200; back += 1) {
    const now = settleLine(sale({ rate: 37 }), back).commission;
    if (now > before) grew += 1;
    before = now;
  }
  is("from nothing to all given back, cent by cent, the share never grows", grew, 0);
}

done();
