/**
 * "Do this next" rules (complement WG of 484 [IT1], unit 1; lib/next-actions-rules.ts). Pure; synthetic counts; the
 * real role table (lib/team-roles.ts). Checked:
 *
 *   - the item's acceptance case: 86 failed payments show "86", first, with a button that prepares and never sends;
 *   - with no data, or every count at zero, no action is invented;
 *   - a count that cannot be read is "unknown", never zero: no action on it, and the view names it;
 *   - a role without the permissions sees neither the action nor that its number is missing;
 *   - at most three, money owed first, then recorded money highest first, money not known or in another currency
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
  type NextFacts,
  type NextView,
} from "@/lib/next-actions-rules";
import { can, type Role } from "@/lib/team-roles";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const AT = Date.UTC(2026, 10, 10, 6, 0, 0);
const usd = (amount: number) => ({ amount, currency: "usd" });
const as = (role: Role) => ({ may: (p: Parameters<typeof can>[1]) => can(role, p), currency: "usd", now: NOW });
const ids = (view: NextView) => (view.kind === "actions" ? view.actions.map((a) => a.id) : []);

const full: NextFacts = {
  failedPayments: { count: 86, owed: usd(258_000), at: AT },
  monthlyMembers: { count: 40, monthly: usd(120_000), at: AT },
  formerMembers: { count: 12, monthly: usd(36_000), at: AT },
  courseNext: { count: 9, from: "Course A", to: "Course B", at: AT },
  noWelcome: { count: 300, at: AT },
};

part("The item's acceptance case");
{
  const view = nextActions({ failedPayments: { count: 86, owed: usd(258_000), at: AT } }, as("owner"));
  is("one action", view.kind === "actions" ? view.actions.length : -1, 1);
  const first = view.kind === "actions" ? view.actions[0] : null;
  is("it says 86", first?.words, "86 card payments for memberships failed this week and are still unpaid.");
  is("with the recorded money", first?.money, "$2,580 unpaid.");
  is("where the number comes from", first?.source, "From your failed membership payments in Stripe.");
  is("when it was counted", first?.asOf, "Counted November 10, 2026 (UTC).");
  is("it prepares a draft", first?.prepare, "draft");
  is("the button prepares, never sends", /send/i.test(first?.button ?? "send"), false);
  is("nothing missing", view.kind === "actions" ? [view.unknown, view.note] : null, [[], null]);
}

part("Nothing is invented");
is("no data at all", nextActions({}, as("owner")), { kind: "nothing", words: NOTHING_NEXT });
is(
  "every count at zero",
  nextActions({ failedPayments: { count: 0, owed: usd(0), at: AT }, monthlyMembers: { count: 0, at: AT }, formerMembers: { count: 0, at: AT }, courseNext: { count: 0, from: "A", to: "B", at: AT }, noWelcome: { count: 0, at: AT } }, as("owner")),
  { kind: "nothing", words: NOTHING_NEXT },
);
is("one person: singular words", nextActions({ noWelcome: { count: 1, at: AT } }, as("owner")).kind === "actions" ? (nextActions({ noWelcome: { count: 1, at: AT } }, as("owner")) as { actions: { words: string }[] }).actions[0].words : "", "1 person joined your list and never got a welcome email.");

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
{
  const view = nextActions({ failedPayments: { count: 3, owed: { amount: 1.5, currency: "usd" }, at: AT } }, as("owner"));
  is("money that is not whole: the action stays, without money", view.kind === "actions" ? view.actions[0].money : "x", null);
  const odd = nextActions({ failedPayments: { count: 3, owed: { amount: 500, currency: "zzz" }, at: AT } }, as("owner"));
  is("money in a currency that is not one: without money", odd.kind === "actions" ? odd.actions[0].money : "x", null);
}

part("Only for a role that may act on it");
is("every action needs the numbers", NEXT_ACTION_ORDER.every((id) => NEXT_ACTION_NEEDS[id].includes("stats")), true);
for (const role of ["owner", "admin", "editor", "support"] as Role[]) {
  const shown = ids(nextActions(full, as(role)));
  const allowed = NEXT_ACTION_ORDER.filter((id) => NEXT_ACTION_NEEDS[id].every((p) => can(role, p)));
  is(`${role}: only what the role may prepare`, shown.every((id) => allowed.includes(id)), true);
  if (!allowed.length) is(`${role}: nothing at all, not even "nothing"`, nextActions(full, as(role)).kind, "nothing");
}
{
  const noSend = { may: (p: Parameters<typeof can>[1]) => p !== "send", currency: "usd", now: NOW };
  is("without send: no welcome automation", ids(nextActions({ noWelcome: { count: 9, at: AT } }, noSend)), []);
  is("and its missing number is not told either", nextActions({ noWelcome: { count: null, at: AT } }, noSend).kind, "nothing");
  const noDraft = { may: (p: Parameters<typeof can>[1]) => p !== "draft", currency: "usd", now: NOW };
  is("without draft: no draft actions", ids(nextActions(full, noDraft)), ["welcome"]);
}

part("At most three, in order");
is("at most three", ids(nextActions(full, as("owner"))).length, NEXT_ACTIONS_MAX);
is("money owed first, then the most money", ids(nextActions(full, as("owner"))), ["failed_payments", "yearly_switch", "winback"]);
{
  const owedSmall: NextFacts = { ...full, failedPayments: { count: 1, owed: usd(500), at: AT } };
  is("money owed first even when smaller", ids(nextActions(owedSmall, as("owner")))[0], "failed_payments");
  const owedUnknown: NextFacts = { ...full, failedPayments: { count: 2, owed: null, at: AT } };
  is("money owed first even when its amount is not known", ids(nextActions(owedUnknown, as("owner")))[0], "failed_payments");
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
  const view = nextActions(full, { may: () => true, currency: "usd", now: NOW });
  const all = view.kind === "actions" ? view.actions.flatMap((a) => [a.words, a.money ?? "", a.source, a.asOf, a.button]) : [];
  const course = nextActions({ courseNext: { count: 9, from: "Course A", to: "Course B", at: AT } }, as("owner"));
  if (course.kind === "actions") all.push(course.actions[0].words, course.actions[0].button);
  is("there are words to check", all.length > 10, true);
  is("no percentage", all.filter((w) => w.includes("%")), []);
  is("no forecast or promise", all.filter((w) => /could earn|you could make|estimat|expected|forecast|guarantee|\bwill earn/i.test(w)), []);
  is("no button sends, switches on or charges", all.filter((w) => /^(send|turn on|charge|start)\b/i.test(w)), []);
  is("the course action names both courses", course.kind === "actions" ? course.actions[0].words : "", '9 students finished "Course A" and do not have "Course B".');
  const long = nextActions({ courseNext: { count: 1, from: "x".repeat(200), to: "B", at: AT } }, as("owner"));
  is("a long title is cut, not dropped", long.kind === "actions" ? long.actions[0].words.includes(`${"x".repeat(79)}…`) : false, true);
  is("the welcome action prepares a paused automation", nextActions({ noWelcome: { count: 2, at: AT } }, as("owner")).kind === "actions" ? (nextActions({ noWelcome: { count: 2, at: AT } }, as("owner")) as { actions: { prepare: string }[] }).actions[0].prepare : "", "paused_automation");
}

done();
