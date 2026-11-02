/**
 * The "Today" screen's rules (484 [IT1], complement item 1, unit 1;
 * lib/today-rules.ts). Pure; synthetic counts; the real role table
 * (lib/team-roles.ts). Checked:
 *
 *   - each line in plain words with its number, in the owner's order;
 *   - a line at zero is not shown; "none" for one day of two;
 *   - a line is shown only to a role that may act on it;
 *   - a number that could not be read is never zero: its part of the line
 *     says so, a sale counted without its revenue too, and the screen never
 *     says "Nothing needs you today" while one is missing;
 *   - everything read and at zero: "Nothing needs you today".
 */
import { NOTHING_TODAY, SOME_UNREAD, TODAY_ORDER, todayView, type TodayCounts } from "@/lib/today-rules";
import { can } from "@/lib/team-roles";
import { done, is, part } from "./check";

const zero: TodayCounts = {
  salesToday: 0, salesYesterday: 0, revenueToday: null, revenueYesterday: null, unreadConversations: 0, bookingsToday: 0, bookingsTomorrow: 0,
  eventsToday: 0, eventsTomorrow: 0, toShip: 0, failedRenewals: 0, reviewsUnanswered: 0, communityReports: 0, affiliateRequests: 0, questionsUnanswered: 0,
};
const owner = (p: Parameters<typeof can>[1]) => can("owner", p);
const support = (p: Parameters<typeof can>[1]) => can("support", p);
const editor = (p: Parameters<typeof can>[1]) => can("editor", p);
const words = (v: ReturnType<typeof todayView>) => (v.kind === "lines" ? v.lines.map((l) => l.words) : [v.words]);

part("The lines");
const busy = todayView(
  { ...zero, salesToday: 3, revenueToday: "$120", salesYesterday: 1, revenueYesterday: "$40", unreadConversations: 2, bookingsToday: 1, eventsTomorrow: 2, toShip: 4, failedRenewals: 2, reviewsUnanswered: 1, communityReports: 3, affiliateRequests: 1, questionsUnanswered: 5 },
  owner,
);
is(
  "each in plain words with its number, in the owner's order; \"none\" for one day of two",
  words(busy),
  [
    "3 sales today ($120), 1 sale yesterday ($40).",
    "2 conversations with unread messages in your inbox.",
    "1 booking today, none tomorrow.",
    "None today, 2 community events tomorrow.",
    "4 orders to ship.",
    "2 membership payments that failed.",
    "1 review without an answer.",
    "3 reports in your community.",
    "1 affiliate request waiting.",
    "5 questions your pages could not answer.",
  ],
);
is("the order", [...TODAY_ORDER], ["sales", "inbox", "calls", "events", "ship", "renewals", "reviews", "reports", "affiliates", "questions"]);
is("no sales today but some yesterday", words(todayView({ ...zero, salesYesterday: 2, revenueYesterday: "$80" }, owner)), ["None today, 2 sales yesterday ($80)."]);

part("Zero and roles");
is("a line at zero is not shown", todayView({ ...zero, unreadConversations: 1 }, owner).kind === "lines" ? (todayView({ ...zero, unreadConversations: 1 }, owner) as { lines: { id: string }[] }).lines.map((l) => l.id) : [], ["inbox"]);
const waiting = { ...zero, unreadConversations: 1, reviewsUnanswered: 2, communityReports: 1, affiliateRequests: 1, questionsUnanswered: 1, eventsToday: 1, failedRenewals: 1 };
const ids = (v: ReturnType<typeof todayView>) => (v.kind === "lines" ? v.lines.map((l) => l.id) : v.kind);
is(
  "only to a role that may act on it, by the real role table",
  [ids(todayView(waiting, support)), ids(todayView(waiting, editor))],
  [["inbox", "reviews", "reports"], ["events", "renewals", "reviews", "reports", "questions"]],
);
is("a role that may act on none of what is waiting is told nothing needs them", todayView({ ...zero, affiliateRequests: 2 }, support), { kind: "nothing", words: NOTHING_TODAY });

part("Numbers not read");
is(
  "never zero: the part not read says so, and the screen does not say nothing needs you",
  [todayView({ ...zero, unreadConversations: null }, owner), todayView({ ...zero, salesToday: null, salesYesterday: 2, revenueYesterday: "$80" }, owner), todayView({ ...zero, bookingsToday: null }, owner)],
  [
    { kind: "lines", lines: [{ id: "inbox", words: "Conversations with unread messages in your inbox: could not be read just now.", permission: "orders" }], unread: true },
    { kind: "lines", lines: [{ id: "sales", words: "Sales today could not be read, 2 sales yesterday ($80).", permission: "orders" }], unread: true },
    { kind: "lines", lines: [{ id: "calls", words: "Bookings today could not be read, none tomorrow.", permission: "orders" }], unread: true },
  ],
);
is("a sale counted without its revenue is a part not read", todayView({ ...zero, salesToday: 2 }, owner), { kind: "lines", lines: [{ id: "sales", words: "2 sales today, none yesterday.", permission: "orders" }], unread: true });
is("a number not read on a line the role cannot see changes nothing for them", todayView({ ...zero, affiliateRequests: null }, support), { kind: "nothing", words: NOTHING_TODAY });
is("what the screen says then", SOME_UNREAD, "Some numbers could not be read just now, so this list may not be complete. Reload the page in a moment.");

part("Nothing needs you");
is("everything read and at zero", todayView(zero, owner), { kind: "nothing", words: "Nothing needs you today." });

done();
