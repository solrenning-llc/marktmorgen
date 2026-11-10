/**
 * "Do this next" rules (complement WG of 484 [IT1], units 1 and 2; lib/next-actions-rules.ts). Pure; synthetic
 * counts; the real role table (lib/team-roles.ts). Checked:
 *
 *   - the item's acceptance case: 86 failed payments show "86", first, as a link to the screen that deals with them;
 *   - with no data, or every count at zero, no action is invented;
 *   - a count that cannot be read is "unknown", never zero: no action on it, and the view names it;
 *   - a role without the permissions, or a screen the studio does not have for this person, shows neither the
 *     action nor that its number is missing;
 *   - at most three, money at risk first, then recorded money highest first, money not known or in another currency
 *     after, then by count, then the fixed order;
 *   - the time each count was made, or that it is not known; no forecast, no percentage in any words.
 */
import {
  NEXT_ACTIONS_MAX,
  NEXT_ACTION_NEEDS,
  NEXT_ACTION_ORDER,
  NOTHING_NEXT,
  asOfWords,
  nextActions,
  unknownWords,
  type NextActionId,
  type NextFacts,
  type NextView,
} from "@/lib/next-actions-rules";
import { can, type Role } from "@/lib/team-roles";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const AT = Date.UTC(2026, 10, 10, 6, 0, 0);
const usd = (amount: number) => ({ amount, currency: "usd" });
const EVERYWHERE: Record<NextActionId, string> = {
  failed_payments: "/studio/memberships",
  yearly_switch: "#yearly-ask-title",
  winback: "#winback-title",
  course_next: "#courses",
  welcome: "#mail",
};
const as = (role: Role, where: Partial<Record<NextActionId, string>> = EVERYWHERE) => ({ may: (p: Parameters<typeof can>[1]) => can(role, p), where, currency: "usd", now: NOW });
const ids = (view: NextView) => (view.kind === "actions" ? view.actions.map((a) => a.id) : []);
const first = (view: NextView) => (view.kind === "actions" ? view.actions[0] : null);

const full: NextFacts = {
  failedPayments: { count: 86, monthly: usd(258_000), at: AT },
  monthlyMembers: { count: 40, monthly: usd(120_000), at: AT },
  formerMembers: { count: 12, monthly: usd(36_000), at: AT },
  courseNext: { count: 9, from: "Course A", to: "Course B", at: AT },
  noWelcome: { count: 300, at: AT },
};

part("The item's acceptance case");
{
  const view = nextActions({ failedPayments: { count: 86, monthly: usd(258_000), at: AT } }, as("owner"));
  is("one action", view.kind === "actions" ? view.actions.length : -1, 1);
  const one = first(view);
  is("it says 86", one?.words, "86 members' latest payment failed, and Stripe is trying again.");
  is("with the recorded money", one?.money, "Together they pay $2,580 a month.");
  is("where the number comes from", one?.source, "From your membership numbers, read from your Stripe account.");
  is("when it was counted", one?.asOf, "Counted November 10, 2026 (UTC).");
  is("a link named by where it goes", [one?.link, one?.href], ["See your membership numbers", "/studio/memberships"]);
  is("the link never sends, switches on or charges", /^(send|turn on|charge|start)\b/i.test(one?.link ?? "send"), false);
  is("nothing missing", view.kind === "actions" ? [view.unknown, view.note] : null, [[], null]);
}

part("Nothing is invented");
is("no data at all: nothing, and nothing looked at", nextActions({}, as("owner")), { kind: "nothing", words: NOTHING_NEXT, looked: false });
is(
  "every count at zero: nothing, and it says it looked",
  nextActions({ failedPayments: { count: 0, monthly: usd(0), at: AT }, monthlyMembers: { count: 0, at: AT }, formerMembers: { count: 0, at: AT }, courseNext: { count: 0, from: "A", to: "B", at: AT }, noWelcome: { count: 0, at: AT } }, as("owner")),
  { kind: "nothing", words: NOTHING_NEXT, looked: true },
);
is("one person: singular words", first(nextActions({ noWelcome: { count: 1, at: AT } }, as("owner")))?.words, "1 person joined your list and never got a welcome email.");
is("one member: singular words", [first(nextActions({ failedPayments: { count: 1, monthly: usd(900), at: AT } }, as("owner")))?.words, first(nextActions({ failedPayments: { count: 1, monthly: usd(900), at: AT } }, as("owner")))?.money], ["1 member's latest payment failed, and Stripe is trying again.", "They pay $9 a month."]);

part("A count that cannot be read is unknown, never zero");
for (const bad of [null, -1, 1.5, Number.NaN, "3", Number.MAX_SAFE_INTEGER + 2] as unknown[]) {
  const view = nextActions({ failedPayments: { count: bad as number, at: AT } }, as("owner"));
  is(`count ${String(bad)}: unknown, never "nothing"`, view, { kind: "unknown", unknown: ["failed_payments"], words: unknownWords(["failed_payments"]) });
}
is("an entry that is not an object: unknown", nextActions({ monthlyMembers: null as never }, as("owner")).kind, "unknown");
{
  const view = nextActions({ failedPayments: { count: null, at: AT }, noWelcome: { count: 5, at: AT } }, as("owner"));
  is("with another action: it is shown", ids(view), ["welcome"]);
  is("and the missing one is named", view.kind === "actions" ? view.note : null, "Some numbers could not be read just now (failed payments), so these suggestions may not be complete. Reload the page in a moment.");
}
is("three names read as a list", unknownWords(["failed_payments", "winback", "welcome"]), "Some numbers could not be read just now (failed payments, former members and welcome emails), so these suggestions may not be complete. Reload the page in a moment.");
is("a course without both titles: unknown", nextActions({ courseNext: { count: 4, from: "  ", to: "Course B", at: AT } }, as("owner")).kind, "unknown");
is("a course pointing to itself: unknown", nextActions({ courseNext: { count: 4, from: "Course A", to: " Course  A ", at: AT } }, as("owner")).kind, "unknown");
is("money that is not whole: the action stays, without money", first(nextActions({ failedPayments: { count: 3, monthly: { amount: 1.5, currency: "usd" }, at: AT } }, as("owner")))?.money, null);
is("money in a currency that is not one: without money", first(nextActions({ failedPayments: { count: 3, monthly: { amount: 500, currency: "zzz" }, at: AT } }, as("owner")))?.money, null);

part("Only for a role that may act on it, and only where the studio has the screen");
is("every action needs the numbers", NEXT_ACTION_ORDER.every((id) => NEXT_ACTION_NEEDS[id].includes("stats")), true);
is("the come-back email is a setting", NEXT_ACTION_NEEDS.winback.includes("settings"), true);
for (const role of ["owner", "admin", "editor", "support"] as Role[]) {
  const view = nextActions(full, as(role));
  const allowed = NEXT_ACTION_ORDER.filter((id) => NEXT_ACTION_NEEDS[id].every((p) => can(role, p)));
  is(`${role}: only what the role may use`, ids(view).every((id) => allowed.includes(id)), true);
  if (!allowed.length) is(`${role}: nothing, and nothing looked at`, view, { kind: "nothing", words: NOTHING_NEXT, looked: false });
}
{
  const noSend = { may: (p: Parameters<typeof can>[1]) => p !== "send", where: EVERYWHERE, currency: "usd", now: NOW };
  is("without send: no welcome email", ids(nextActions({ noWelcome: { count: 9, at: AT } }, noSend)), []);
  is("and its missing number is not told either", nextActions({ noWelcome: { count: null, at: AT } }, noSend).kind, "nothing");
  const noSettings = { may: (p: Parameters<typeof can>[1]) => p !== "settings", where: EVERYWHERE, currency: "usd", now: NOW };
  is("without settings: no come-back or yearly email", ids(nextActions(full, noSettings)), ["failed_payments", "welcome", "course_next"]);
  is("a screen the studio does not have: left out", ids(nextActions(full, as("owner", { failed_payments: "/studio/memberships", welcome: "" }))), ["failed_payments"]);
  is("nor its missing number", nextActions({ formerMembers: { count: null, at: AT } }, as("owner", { failed_payments: "/studio/memberships" })), { kind: "nothing", words: NOTHING_NEXT, looked: false });
}

part("At most three, in order");
is("at most three", ids(nextActions(full, as("owner"))).length, NEXT_ACTIONS_MAX);
is("money at risk first, then the most money", ids(nextActions(full, as("owner"))), ["failed_payments", "yearly_switch", "winback"]);
{
  const atRiskSmall: NextFacts = { ...full, failedPayments: { count: 1, monthly: usd(500), at: AT } };
  is("money at risk first even when smaller", ids(nextActions(atRiskSmall, as("owner")))[0], "failed_payments");
  const atRiskUnknown: NextFacts = { ...full, failedPayments: { count: 2, monthly: null, at: AT } };
  is("money at risk first even when its amount is not known", ids(nextActions(atRiskUnknown, as("owner")))[0], "failed_payments");
  const swapped: NextFacts = { monthlyMembers: { count: 2, monthly: usd(1_000), at: AT }, formerMembers: { count: 1, monthly: usd(9_000), at: AT } };
  is("more recorded money first, whatever the count", ids(nextActions(swapped, as("owner"))), ["winback", "yearly_switch"]);
  const unknownMoney: NextFacts = { monthlyMembers: { count: 500, monthly: null, at: AT }, formerMembers: { count: 1, monthly: usd(100), at: AT } };
  is("money not known is not ranked above known money", ids(nextActions(unknownMoney, as("owner"))), ["winback", "yearly_switch"]);
  const otherCurrency: NextFacts = { monthlyMembers: { count: 2, monthly: { amount: 9_999_999, currency: "eur" }, at: AT }, formerMembers: { count: 1, monthly: usd(100), at: AT } };
  const view = nextActions(otherCurrency, as("owner"));
  is("money in another currency is not compared", ids(view), ["winback", "yearly_switch"]);
  is("but still said", view.kind === "actions" ? view.actions[1].money : null, "Together they pay €99,999.99 a month now.");
  const noMoney: NextFacts = { courseNext: { count: 9, from: "A", to: "B", at: AT }, noWelcome: { count: 300, at: AT } };
  is("without money: by count", ids(nextActions(noMoney, as("owner"))), ["welcome", "course_next"]);
  const tie: NextFacts = { courseNext: { count: 5, from: "A", to: "B", at: AT }, noWelcome: { count: 5, at: AT } };
  is("a tie keeps the fixed order", ids(nextActions(tie, as("owner"))), ["course_next", "welcome"]);
}

part("When it was counted");
is("a time", asOfWords(AT, NOW), "Counted November 10, 2026 (UTC).");
is("no time", asOfWords(null, NOW), "When this was counted is not known.");
is("not a number", asOfWords(Number.NaN, NOW), "When this was counted is not known.");
is("in the future", asOfWords(NOW + 60 * 60 * 1000, NOW), "When this was counted is not known.");
is("a little ahead (clock skew) is fine", asOfWords(NOW + 60 * 1000, NOW), "Counted November 10, 2026 (UTC).");

part("Words: facts, never a forecast");
{
  const view = nextActions(full, { may: () => true, where: EVERYWHERE, currency: "usd", now: NOW });
  const all = view.kind === "actions" ? view.actions.flatMap((a) => [a.words, a.money ?? "", a.source, a.asOf, a.link]) : [];
  const course = nextActions({ courseNext: { count: 9, from: "Course A", to: "Course B", at: AT } }, as("owner"));
  if (course.kind === "actions") all.push(course.actions[0].words, course.actions[0].link);
  const left = nextActions({ formerMembers: { count: 4, monthly: usd(8_000), at: AT } }, as("owner"));
  if (left.kind === "actions") all.push(left.actions[0].words, left.actions[0].money ?? "", left.actions[0].link);
  is("there are words to check", all.length > 10, true);
  is("no percentage", all.filter((w) => w.includes("%")), []);
  is("no forecast or promise", all.filter((w) => /could earn|you could make|estimat|expected|forecast|guarantee|\bwill earn/i.test(w)), []);
  is("no link sends, switches on or charges", all.filter((w) => /^(send|turn on|charge|start)\b/i.test(w)), []);
  is("the course action names both courses", course.kind === "actions" ? course.actions[0].words : "", '9 students finished "Course A" and do not have "Course B".');
  is("the members who left, and that the come-back email is off", left.kind === "actions" ? [left.actions[0].words, left.actions[0].money, left.actions[0].link] : null, ["4 members left in the last 30 days, and your come-back email is off.", "Together they paid $80 a month before leaving.", "Set up the come-back email"]);
  const long = nextActions({ courseNext: { count: 1, from: "x".repeat(200), to: "B", at: AT } }, as("owner"));
  is("a long title is cut, not dropped", long.kind === "actions" ? long.actions[0].words.includes(`${"x".repeat(79)}…`) : false, true);
}

done();
