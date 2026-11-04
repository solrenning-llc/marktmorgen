/**
 * "Today" in the studio (484 [IT1], complement item 1, unit 2a; added 2
 * November 2026): sales and bookings from the readings the studio's first
 * screen already makes, each line a link to the place that deals with it; no
 * number it cannot stand behind; and no "Nothing needs you today" while lines
 * the person may see are not read on this screen yet.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { TodayPanel } from "@/components/today-panel";
import { can, type Role } from "@/lib/team-roles";
import { bookingCounts, NOTHING_TODAY, quietWords, salesCounts, SOME_UNREAD, todayView, utcDay, type TodayCounts } from "@/lib/today-rules";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 2, 15, 0); // 2 November 2026, 15:00 UTC
const DAY = 86_400_000;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const all = () => true;
const ok = (byDay: Record<string, { sales: number; cents: number }>, partial = false, elsewhere = 0) => ({ state: "ok" as const, value: { byDay, partial, elsewhere } });

part("Sales today and yesterday, from the studio's own reading");
const byDay = { [utcDay(NOW)]: { sales: 2, cents: 12000 }, [utcDay(NOW - DAY)]: { sales: 1, cents: 4900 }, [utcDay(NOW - 2 * DAY)]: { sales: 9, cents: 1 } };
is("read: the two UTC days, with what was paid", salesCounts(ok(byDay), money, NOW), { salesToday: 2, salesYesterday: 1, revenueToday: "$120.00 paid", revenueYesterday: "$49.00 paid" });
is("a day with no sale is none", salesCounts(ok({}), money, NOW), { salesToday: 0, salesYesterday: 0, revenueToday: "$0.00 paid", revenueYesterday: "$0.00 paid" });
is("a failed reading: not read, said so", [salesCounts({ state: "error", value: null }, money, NOW), salesCounts({ state: "ok", value: null }, money, NOW)], Array(2).fill({ salesToday: null, salesYesterday: null, revenueToday: null, revenueYesterday: null }));
is("a reading cut at its last page, or with sales in another currency: no line at all, since reloading would not change it", [salesCounts(ok(byDay, true), money, NOW), salesCounts(ok(byDay, false, 1), money, NOW)], [{}, {}]);
is("a store with no account to sell through has no sales", salesCounts({ state: "none", value: null }, money, NOW), { salesToday: 0, salesYesterday: 0, revenueToday: null, revenueYesterday: null });
is("the line, in words, for a role with the numbers", todayView(salesCounts(ok(byDay), money, NOW), all), { kind: "lines", lines: [{ id: "sales", words: "2 sales today ($120.00 paid), 1 sale yesterday ($49.00 paid).", permission: "stats" }], unread: false });

part("Bookings not over yet today, and tomorrow's");
const at = (hoursFromNow: number, minutes = 60) => ({ start: NOW + hoursFromNow * 3_600_000, end: NOW + hoursFromNow * 3_600_000 + minutes * 60_000 });
const read = (paid: { start: number; end: number }[], partial = false) => ({ paid, partial });
is(
  "by UTC day, one per person: one over left out, one going on counted, 23:30 today, 00:30 tomorrow, the day after left out",
  bookingCounts(read([at(-3), at(-0.5), at(2), at(2), at(8.5), at(9.5), at(30), at(34)]), NOW),
  { bookingsToday: 4, bookingsTomorrow: 2 },
);
is("a call going on since before midnight counts as today's", bookingCounts(read([at(-15.5, 16 * 60)]), NOW), { bookingsToday: 1, bookingsTomorrow: 0 });
is("the words say only those not over yet", todayView(bookingCounts(read([at(2)]), NOW), all), { kind: "lines", lines: [{ id: "calls", words: "1 booking still to come today, none tomorrow.", permission: "orders" }], unread: false });
is("not read: said so, never none", todayView(bookingCounts(null, NOW), all), { kind: "lines", lines: [{ id: "calls", words: "Bookings still to come today could not be read, bookings tomorrow could not be read.", permission: "orders" }], unread: true });
is("a reading cut at its last page, where an older checkout may hold one of these: no line", bookingCounts(read([at(2)], true), NOW), {});

part("Never 'Nothing needs you today' from part of the lines");
const zero: TodayCounts = { ...salesCounts(ok({}), money, NOW), bookingsToday: 0, bookingsTomorrow: 0 };
is("sales and bookings quiet, the rest not read here: only those said quiet", todayView(zero, all), { kind: "quiet", looked: ["sales", "calls"], words: "Nothing new in sales and bookings today." });
is("the words for one and three; none for none", [quietWords(["sales"]), quietWords(["sales", "calls", "ship"]), quietWords([])], ["Nothing new in sales today.", "Nothing new in sales, bookings and orders to ship today.", ""]);
const everything: TodayCounts = { ...zero, unreadConversations: 0, eventsToday: 0, eventsTomorrow: 0, toShip: 0, failedRenewals: 0, reviewsUnanswered: 0, communityReports: 0, affiliateRequests: 0, questionsUnanswered: 0 };
is("only with every line read and at zero", todayView(everything, all), { kind: "nothing", words: NOTHING_TODAY });
is("lines left out never count as not read", todayView({ salesToday: 1, salesYesterday: 0, revenueToday: "$5.00 paid", revenueYesterday: "$0.00 paid" }, all), { kind: "lines", lines: [{ id: "sales", words: "1 sale today ($5.00 paid), none yesterday.", permission: "stats" }], unread: false });

part("Each role, by the real role table");
const view = (role: Role) => todayView({ ...zero, salesToday: 2, revenueToday: "$9.00 paid", bookingsToday: 1 }, (p) => can(role, p));
const ids = (v: ReturnType<typeof todayView>) => (v.kind === "lines" ? v.lines.map((l) => l.id) : v.kind);
is("the owner: sales and bookings; an editor, who sees the numbers but not orders: sales", [ids(view("owner")), ids(view("editor"))], [["sales", "calls"], ["sales"]]);
const noCalls = salesCounts(ok({}), money, NOW); // a store that sells no calls: only the sales line is read
is("support on a store with no calls: nothing it may see is read here, and so no panel", [todayView(noCalls, (p) => can("support", p)), renderPanel(todayView(noCalls, (p) => can("support", p)), {})], [{ kind: "quiet", looked: [], words: "" }, ""]);

part("The panel");
function renderPanel(v: ReturnType<typeof todayView>, hrefs: Record<string, string>) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never }, createElement(TodayPanel, { view: v, hrefs, at: NOW })));
}
const lines = todayView({ ...zero, salesToday: 2, revenueToday: "$120.00 paid", bookingsToday: 1 }, all);
const html = renderPanel(lines, { sales: "#numbers", calls: "#calls-title" });
is("under its heading, the moment counted and the day said, UTC spelled out", [html.includes('<h2 id="today-title"'), html.includes("Counted when this page opened, at 3:00 PM "), (html.match(/<abbr title="Coordinated Universal Time">UTC<\/abbr>/g) ?? []).length], [true, true, 2]);
is("each line a link saying where it goes, 44 px tall", [/<a class="[^"]*min-h-11[^"]*" href="#numbers"><span class="font-semibold">2 sales today \(\$120.00 paid\), none yesterday.<\/span><span[^>]*>See your numbers<\/span><\/a>/.test(html), /href="#calls-title"><span class="font-semibold">1 booking still to come today, none tomorrow.<\/span><span[^>]*>See your upcoming calls<\/span>/.test(html)], [true, true]);
is("a line without its place is not drawn; with none drawn and nothing else to say, no panel", [renderPanel(lines, { sales: "#numbers" }).includes("booking"), renderPanel(todayView({ salesToday: 1, salesYesterday: 0, revenueToday: "$1.00 paid", revenueYesterday: "$0.00 paid" }, all), {})], [false, ""]);
is("part not read: said under the lines", renderPanel(todayView(bookingCounts(null, NOW), all), { calls: "#calls-title" }).includes(SOME_UNREAD), true);
is("quiet and nothing: their words", [renderPanel(todayView(zero, all), {}).includes("Nothing new in sales and bookings today."), renderPanel(todayView(everything, all), {}).includes(NOTHING_TODAY)], [true, true]);

part("In the studio");
const page = readFileSync("app/studio/page.tsx", "utf8");
is("sales counted only with the numbers on the page, and bookings only with the calls list, from the same reading", [page.includes("current && numbers && salesRead ? salesCounts("), page.includes('current && callProducts.length > 0 && may("orders") ? (current.stripeAccountId ? bookingCounts(paidRead, today)'), page.includes('{numbers ? (\n              <div id="numbers"'), page.includes('{callProducts.length > 0 && may("orders") ? (\n              <section className="card mt-8 p-6 sm:p-8" aria-labelledby="calls-title">'), page.includes("await paidCallsRead(current)"), page.includes("const paidList = paidRead ? paidRead.paid : null;")], [true, true, true, true, true, true]);
is("each place given only with its count, the calls heading clear of the sticky bar", [page.includes('todayCounts.salesToday !== undefined ? { sales: "#numbers" }'), page.includes('todayCounts.bookingsToday !== undefined ? { calls: "#calls-title" }'), page.includes('<h2 id="calls-title" className="scroll-mt-32 ')], [true, true, true]);
is("right after the first steps, by the person's own permissions, with the moment counted", [page.indexOf("<TodayPanel view={todayScreen}") > page.indexOf("<StudioStart steps={startSteps}"), page.includes("todayView(todayCounts, may)"), page.includes("hrefs={todayHrefs} at={today}")], [true, true, true]);
const calls = readFileSync("lib/calls.ts", "utf8");
is("the bookings' reading says when it stopped with more to read", [calls.includes("if (page === MAX_PAGES - 1) partial = true;"), calls.includes("export async function paidCallsRead(store: Store)")], [true, true]);

done();
