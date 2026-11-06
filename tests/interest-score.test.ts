/**
 * A contact's interest, scored from what they did with the store (268 [KT2],
 * unit 1; lib/interest-score.ts; added 1 November 2026). Checked: each rule
 * gives its points and stops at its cap; every point comes with its reason;
 * the windows hold at their edges, in each source's own unit (the ledger in
 * milliseconds, the community's lastSeenIn in seconds); future dates and bad
 * input give nothing; no open and no link use is an input; no prediction.
 */
import { readFileSync } from "node:fs";
import { INTEREST_MOST, INTEREST_RULES, interestScore, type InterestSignals } from "@/lib/interest-score";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 1);
const NOW_S = Math.floor(NOW / 1000);
const DAY = 86_400_000;
const none: InterestSignals = { orders: 0, lastBought: 0, joinedThemselves: false, lastSeenInCommunitySeconds: 0 };

function main(): void {
  part("Each rule, its points, its cap");
  is("nothing done: 0, no reasons", interestScore(none, NOW), { score: 0, reasons: [] });
  is("each purchase 3, up to 5", [1, 5, 9].map((orders) => interestScore({ ...none, orders }, NOW).score), [3, 15, 15]);
  is("exactly 5 says 5, more says or more; one says once", [interestScore({ ...none, orders: 5 }, NOW).reasons[0].words, interestScore({ ...none, orders: 6 }, NOW).reasons[0].words, interestScore({ ...none, orders: 1 }, NOW).reasons[0].words], ["Bought 5 times", "Bought 5 times or more", "Bought once"]);
  is("bought in the last 90 days: 2 more, at its edge", [interestScore({ ...none, orders: 1, lastBought: NOW - 90 * DAY }, NOW).score, interestScore({ ...none, orders: 1, lastBought: NOW - 91 * DAY }, NOW).score], [5, 3]);
  is("joined the list themselves: 2", interestScore({ ...none, joinedThemselves: true }, NOW), { score: 2, reasons: [{ points: 2, words: "Joined your list themselves" }] });
  is("in the community in 30 days, read in seconds as lastSeenIn gives it", [interestScore({ ...none, lastSeenInCommunitySeconds: NOW_S - 30 * 86_400 }, NOW).score, interestScore({ ...none, lastSeenInCommunitySeconds: NOW_S - 31 * 86_400 }, NOW).score], [2, 0]);
  is("the most anybody can have", [INTEREST_MOST, interestScore({ orders: 9, lastBought: NOW, joinedThemselves: true, lastSeenInCommunitySeconds: NOW_S }, NOW).score], [21, 21]);

  part("Nothing from what did not happen");
  is("a future purchase or visit gives nothing", [interestScore({ ...none, orders: 1, lastBought: NOW + DAY }, NOW).score, interestScore({ ...none, lastSeenInCommunitySeconds: NOW_S + 86_400 }, NOW).score], [3, 0]);
  is("a recent date without a counted purchase gives nothing", interestScore({ ...none, lastBought: NOW - DAY }, NOW).score, 0);
  is("bad input never adds", interestScore({ orders: Number.NaN, lastBought: Infinity, joinedThemselves: false, lastSeenInCommunitySeconds: Infinity }, NOW).score, 0);
  const all = interestScore({ orders: 7, lastBought: NOW - DAY, joinedThemselves: true, lastSeenInCommunitySeconds: NOW_S - 3600 }, NOW);
  is("the reasons add up to the score, said as what happened", [all.reasons.reduce((n, r) => n + r.points, 0) === all.score, all.reasons.map((r) => r.words)], [true, ["Bought 5 times or more", "Bought in the last 90 days", "Joined your list themselves", "In your community in the last 30 days"]]);

  part("What it never uses or says");
  const signalsType = /export type InterestSignals = \{[\s\S]*?\n\};/.exec(readFileSync("lib/interest-score.ts", "utf8"))?.[0] ?? "";
  is("no email opened and no link used among the inputs", [signalsType.length > 50, /open|click|link/i.test(signalsType)], [true, false]);
  is("no prediction in any rule or reason", /will|likely|predict|expect|future|risk|hot lead|cold/i.test(JSON.stringify(INTEREST_RULES) + JSON.stringify(all)), false);
}

main();
done();
