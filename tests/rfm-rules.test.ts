/**
 * Buyers in groups by recency, frequency and value (270 [GR1], unit 1;
 * lib/rfm-rules.ts; added 1 November 2026). Checked: every buyer with a
 * purchase is in exactly one group, at each group's own edges, as its rule
 * says in words, each rule naming only who is in it; a buyer with no purchase
 * here (brought over) is in none; the summary adds up the store's own
 * figures; no name predicts or alarms.
 */
import { RFM_GROUPS, rfmGroup, rfmSummary, type RfmBuyer } from "@/lib/rfm-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 1);
const DAY = 86_400_000;
const buyer = (orders: number, daysAgo: number, cents = 1000): RfmBuyer => ({ orders, last: NOW - daysAgo * DAY, cents });

function main(): void {
  part("Each group at its own edges");
  is("best: 3 or more times, the last in 90 days", [rfmGroup(buyer(3, 90), NOW), rfmGroup(buyer(7, 1), NOW), rfmGroup(buyer(3, 91), NOW)], ["best", "best", "loyal"]);
  is("loyal: 2 or more times, the last in 180 days", [rfmGroup(buyer(2, 1), NOW), rfmGroup(buyer(2, 180), NOW), rfmGroup(buyer(2, 181), NOW)], ["loyal", "loyal", "quiet-often"]);
  is("new: once, in 30 days", [rfmGroup(buyer(1, 0), NOW), rfmGroup(buyer(1, 30), NOW), rfmGroup(buyer(1, 31), NOW)], ["new", "new", "once"]);
  is("bought once: between 30 and 180 days ago", [rfmGroup(buyer(1, 100), NOW), rfmGroup(buyer(1, 180), NOW), rfmGroup(buyer(1, 181), NOW)], ["once", "once", "quiet-once"]);
  is("at risk: 2 or more times, none in 180 days", rfmGroup(buyer(9, 400), NOW), "quiet-often");
  is("no purchase here (brought over): in no group", [rfmGroup({ orders: 0, last: 0, cents: 0 }, NOW), rfmGroup({ orders: 2, last: 0, cents: 0 }, NOW)], [null, null]);
  is("an offer after paying read without its checkout is still a purchase", rfmGroup({ orders: 0, last: NOW - 5 * DAY, cents: 4000 }, NOW), "new");

  part("Exactly one group each, as the rules say");
  const ids = new Set(RFM_GROUPS.map((g) => g.id));
  let every = true;
  for (let orders = 1; orders <= 6; orders += 1) for (let days = 0; days <= 500; days += 1) every &&= ids.has(rfmGroup(buyer(orders, days), NOW) as never);
  is("every buyer with a purchase, any day, any count, falls in one", every, true);
  is("six groups, each with a name and its rule in words", RFM_GROUPS.map((g) => [g.id, g.name.length > 5, g.rule.endsWith(".")]), [["best", true, true], ["loyal", true, true], ["new", true, true], ["once", true, true], ["quiet-often", true, true], ["quiet-once", true, true]]);
  is("the rules' numbers are the ones the groups use", RFM_GROUPS.map((g) => g.rule.match(/\d+/g)?.join(",")), ["3,90", "2,180,2,3,90", "30", "30,180", "2,180", "180"]);
  is("no prediction or alarm in any word", /will|likely|predict|expect|future|risk|lost|churn|danger/i.test(RFM_GROUPS.map((g) => `${g.name} ${g.rule}`).join(" ")), false);
  const loyal = RFM_GROUPS.find((g) => g.id === "loyal")!.rule;
  is("someone who fits Best is told, by Loyal's own rule, they are not in it", [rfmGroup(buyer(5, 60), NOW), loyal.includes("and not a best customer")], ["best", true]);
  is("day 30 is said once: new up to 30, bought once from more than 30", [rfmGroup(buyer(1, 30), NOW), RFM_GROUPS.find((g) => g.id === "once")!.rule.includes("more than 30 and up to 180")], ["new", true]);

  part("The summary, from the store's own figures");
  const summary = rfmSummary([buyer(3, 5, 5000), buyer(4, 10, 2500), buyer(1, 3, 900), buyer(2, 300, 1200), { orders: 0, last: 0, cents: 0 }], NOW);
  is("each group's buyers and what they spent in all", summary.map((g) => [g.id, g.buyers, g.cents]), [["best", 2, 7500], ["loyal", 0, 0], ["new", 1, 900], ["once", 0, 0], ["quiet-often", 1, 1200], ["quiet-once", 0, 0]]);
  is("a buyer brought over is counted nowhere", summary.reduce((n, g) => n + g.buyers, 0), 4);
}

main();
done();
