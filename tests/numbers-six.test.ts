/**
 * The sixth part of the numbers, added on 11 October 2026: why members leave
 * and the next three months of memberships (lib/membership-numbers.ts), a
 * checkout Stripe would not open (lib/checkout-trouble.ts), the call on each
 * channel's ads and the day they paid back (lib/ad-spend-rules.ts), the
 * buyers' file for ad audiences (lib/ad-audience.ts), the month's goal
 * (lib/sales-goal-rules.ts), records (lib/records.ts), the monthly email
 * (lib/stats-report.ts) and the Slack or Discord summary
 * (lib/chat-summary.ts). What is checked:
 *
 *   - a member's own reason is read from Stripe and summed, a failed payment
 *     is not a choice, and a membership with a set end is not somebody leaving;
 *   - a forecast is only made from enough members, and says what it carries;
 *   - a refusal is counted and the creator told once a day, Stripe being down
 *     is counted and not emailed about;
 *   - the call speaks only above its floor, and payback counts renewals;
 *   - the audience file holds only buyers who agreed and are still on the list;
 *   - a goal, a record and a month are worked out from the days of money;
 *   - only a Slack or Discord address is ever kept, sealed, after it took a
 *     first message, and what is posted pings nobody.
 */
import { forecastFrom, leavingFrom, readSub, type Sub } from "@/lib/membership-numbers";
import { noteCheckoutTrouble, readTrouble } from "@/lib/checkout-trouble";
import { StripeError } from "@/lib/stripe-account";
import { paybackOf, verdictFor, type AdSpend } from "@/lib/ad-spend-rules";
import { renewalsFrom, type StatsData } from "@/lib/stats";
import { audienceCsv, buyerAudience } from "@/lib/ad-audience";
import { stopWriting, upsertContact } from "@/lib/contacts";
import { goalProgress, moneyByDay, readGoal } from "@/lib/sales-goal-rules";
import { goalForMonth, readSalesGoal, setSalesGoal } from "@/lib/sales-goal";
import { recordsFrom } from "@/lib/records";
import { lastMonthOf, monthlyMessage, weeklyMessage } from "@/lib/stats-report";
import { insightsFrom } from "@/lib/insights";
import { chatAddress, chatBody, chatKind, chatSetup, forChat, setChatAddress } from "@/lib/chat-summary";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { redisPipeline } from "@/lib/redis";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_numbers_six_stand_in";
process.env.RESEND_API_KEY = "re_test_numbers_six_only";

const OWNER = "owner@example.com";
const DAY = 86_400;
const SLACK = "https://hooks.slack.com/services/T0000/B0000/abcdefghijklmnop";
const DISCORD = "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz012345";

const emails: { to: string; subject: string; text: string }[] = [];
const posted: { url: string; body: Record<string, unknown> }[] = [];
let chatAnswers = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${emails.length}` });
  }
  if (url.hostname === "hooks.slack.com" || url.hostname === "discord.com") {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response("ok", { status: chatAnswers });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const day = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const now = 2_000_000_000;

  part("Why members leave");
  const handles = new Set(["harbor"]);
  const raw = (over: Record<string, unknown>) => ({
    id: "sub_1",
    status: "canceled",
    currency: "usd",
    metadata: { store: "harbor", product: "club000001" },
    start_date: now - 200 * DAY,
    ended_at: now - 5 * DAY,
    canceled_at: now - 10 * DAY,
    items: { data: [{ quantity: 1, price: { unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } } }] },
    ...over,
  });
  const read = readSub(raw({ cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive", comment: "  Great,\n but  pricey. " } }), handles)!;
  is("the member's own reason and words are read from Stripe, the words on one line", [read.feedback, read.comment, read.cancelCause, read.canceledAt], ["too_expensive", "Great, but pricey.", "cancellation_requested", now - 10 * DAY]);
  const ending = readSub(raw({ metadata: { store: "harbor", product: "club000001", ends_after: "6" }, cancellation_details: { reason: "cancellation_requested" } }), handles)!;
  is("a membership with a set number of payments ending is not somebody leaving", [ending.canceledAt, ending.cancelCause], [0, ""]);
  const subs: Sub[] = [
    read,
    readSub(raw({ id: "sub_2", canceled_at: now - 3 * DAY, cancellation_details: { reason: "cancellation_requested", feedback: "too_expensive" } }), handles)!,
    readSub(raw({ id: "sub_3", canceled_at: now - 2 * DAY, cancellation_details: { reason: "cancellation_requested", feedback: "unused", comment: "No time" } }), handles)!,
    readSub(raw({ id: "sub_4", canceled_at: now - 1 * DAY, cancellation_details: { reason: "cancellation_requested" } }), handles)!,
    readSub(raw({ id: "sub_5", canceled_at: 0, cancellation_details: { reason: "payment_failed" } }), handles)!,
    readSub(raw({ id: "sub_6", canceled_at: now - 400 * DAY, cancellation_details: { reason: "cancellation_requested", feedback: "other" } }), handles)!,
    ending,
  ];
  const leaving = leavingFrom(subs, "usd", now);
  is("those who chose to leave in the last year, and those who said why", [leaving.canceled, leaving.answered], [4, 3]);
  is("reasons summed, the most first, with what they paid a month", leaving.reasons, [
    { reason: "too_expensive", members: 2, mrr: 5800 },
    { reason: "unused", members: 1, mrr: 2900 },
  ]);
  is("a payment that never went through is said apart, not counted as a choice", leaving.paymentFailed, 1);
  is("their words, the latest first, with no name or address", leaving.comments.map((c) => [c.text, c.reason]), [
    ["No time", "unused"],
    ["Great, but pricey.", "too_expensive"],
  ]);

  part("The next three months");
  const member = (over: Partial<Sub>): Sub => ({ id: "s", status: "active", product: "club", amount: 1000, currency: "usd", interval: "month", count: 1, start: now - 200 * DAY, ended: 0, trialEnd: 0, channel: "direct", canceledAt: 0, cancelCause: "", feedback: "", comment: "", ...over });
  is("no forecast from fewer than five members paying 90 days ago", forecastFrom([member({}), member({}), member({}), member({})], "usd", now, 4000), null);
  const ten = Array.from({ length: 10 }, () => member({}));
  const forecast = forecastFrom([...ten, member({ ended: now - 30 * DAY, status: "canceled" }), member({ start: now - 30 * DAY }), member({ start: now - 60 * DAY, currency: "eur" })], "usd", now, 11_000)!;
  is("losing one of eleven in 90 days is about 3% a month", Math.round(forecast.lost * 1000), 31);
  is("gaining one $10 member in 90 days is $3.33 a month", forecast.gained, 333);
  is("each month keeps its share and adds its gain", forecast.months, [10989, 10979, 10969]);
  is("a member who joined and left inside the 90 days gained nothing", forecastFrom([...ten, ...Array.from({ length: 9 }, () => member({ start: now - 80 * DAY, ended: now - 50 * DAY, status: "canceled" }))], "usd", now, 10_000)!.gained, 0);
  is("nor one whose first payment never went through", forecastFrom([...ten, member({ start: now - 10 * DAY, status: "incomplete_expired" })], "usd", now, 10_000)!.gained, 0);
  is("a trial that ended unpaid never paid", forecastFrom([...ten, member({ start: now - 20 * DAY, trialEnd: now - 6 * DAY, ended: now - 6 * DAY })], "usd", now, 10_000)!.gained, 0);

  part("A checkout Stripe would not open");
  emails.length = 0;
  const refused = new StripeError(400, "account_invalid", "Your account cannot currently make live charges.");
  is("a refusal is counted and the creator told", await noteCheckoutTrouble(store, refused, now * 1000), "emailed");
  is("in Stripe's own words, saying what to look at", [emails[0]?.to, /would not open a checkout/.test(emails[0]?.subject ?? ""), /cannot currently make live charges/.test(emails[0]?.text ?? ""), /Stripe dashboard/.test(emails[0]?.text ?? "")], [OWNER, true, true, true]);
  is("a second on the same day is counted, not emailed", [await noteCheckoutTrouble(store, refused, now * 1000 + 60_000), emails.length], ["counted", 1]);
  is("Stripe being down is counted, never emailed", [await noteCheckoutTrouble(store, new StripeError(503, "api_error", "Try again."), now * 1000 + 120_000), emails.length], ["counted", 1]);
  is("nor a refusal of our own making, which is not Stripe's", await noteCheckoutTrouble(store, new Error("This cannot be pre-ordered"), now * 1000), "skipped");
  const trouble = await readTrouble(store.statsId, now * 1000 + 3_600_000);
  is("the studio reads the week's count and the last words", [trouble.week, trouble.last?.message], [3, "Try again."]);
  is("and nothing a week later", (await readTrouble(store.statsId, now * 1000 + 8 * DAY * 1000)).week, 0);
  is("the next day's first refusal is emailed again", [await noteCheckoutTrouble(store, refused, now * 1000 + DAY * 1000), emails.length], ["emailed", 2]);

  part("Spend more, keep or cut");
  is("below the floor, nothing is said", verdictFor(5000, 900), null);
  is("2 back for each 1 is spend more, under 1 is cut, between is keep", [verdictFor(2000, 1000), verdictFor(999, 1000), verdictFor(1500, 1000)], ["scale", "cut", "keep"]);

  part("When ads paid back");
  const spends: AdSpend[] = [{ id: "a", channel: "instagram", campaign: "", cents: 10_000, from: "2026-09-01", to: "2026-09-10" }];
  const money = { "2026-09-02": 3000, "2026-09-05": 4000, "2026-09-12": 3500 };
  is("counted from the first day of spend, to the day the money covered it", paybackOf(spends, "instagram", money, "2026-08-15", "2026-09-30"), { spent: 10_000, back: 10_500, days: 12 });
  is("not yet, with how much has come back", paybackOf(spends, "instagram", { "2026-09-02": 3000 }, "2026-08-15", "2026-09-30"), { spent: 10_000, back: 3000, days: null });
  is("and nothing for a channel nobody spent on", paybackOf(spends, "tiktok", money, "2026-08-15", "2026-09-30"), null);
  const renewals = renewalsFrom(
    store,
    [
      { status: "paid", billing_reason: "subscription_cycle", currency: "usd", amount_paid: 900, created: Date.parse("2026-09-12T10:00:00Z") / 1000, parent: { subscription_details: { metadata: { store: "harbor", channel: "instagram" } } } },
      { status: "paid", billing_reason: "subscription_cycle", currency: "usd", amount_paid: 900, created: Date.parse("2026-09-12T11:00:00Z") / 1000, parent: { subscription_details: { metadata: { store: "harbor", channel: "direct" } } } },
    ],
    Date.parse("2026-09-30T00:00:00Z"),
    "usd",
  );
  is("a renewal is put on its channel's day, so payback counts it", renewals.bySourceDay, { instagram: { "2026-09-12": 900 }, direct: { "2026-09-12": 900 } });

  part("Buyers for ad audiences");
  const LIST = "list6six";
  await upsertContact(LIST, "b@example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);
  await upsertContact(LIST, "A@Example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);
  await upsertContact(LIST, "lead@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(LIST, "quiet@example.com", { agreed: false, explicit: false, source: "buyer" }, ROOM);
  await upsertContact(LIST, "gone@example.com", { agreed: true, explicit: true, source: "buyer" }, ROOM);
  await stopWriting(LIST, "gone@example.com", "complained");
  const file = await buyerAudience({ ...store, listId: LIST });
  is("only buyers who agreed and are still on the list, one address a line", [file.csv, file.rows], ['email\r\n"a@example.com"\r\n"b@example.com"\r\n', 2]);
  is("an empty file still has its header", audienceCsv([]), "email\r\n");

  part("The month's goal");
  is("a goal is a whole positive amount, or 0 for none", [readGoal(300000), readGoal(0), readGoal(-1), readGoal(1.5), readGoal("x")], [300000, 0, null, null, null]);
  await setSalesGoal(store.statsId!, 300_000, "usd", Date.parse("2026-10-01T03:00:00Z"));
  is("kept for the store, with the month it was set in", await readSalesGoal(store.statsId, "usd"), { cents: 300_000, since: "2026-10" });
  is("and not read as a goal in another currency", await readSalesGoal(store.statsId, "jpy"), { cents: 0, since: "" });
  const channelDays = { instagram: { "2026-10-01": 50_000, "2026-10-05": 40_000, "2026-09-30": 99_000 }, direct: { "2026-10-05": 10_000 } };
  const byDay = moneyByDay(channelDays);
  is("every channel's money on a day added up", byDay["2026-10-05"], 50_000);
  is("this month only, with what a day must bring for the days left", goalProgress(300_000, byDay, "2026-10-11"), {
    month: "2026-10",
    goal: 300_000,
    done: 100_000,
    share: 1 / 3,
    day: 11,
    days: 31,
    perDay: 10_000,
    onPace: 281_818,
    reachedOn: null,
  });
  is("and the day it was reached", goalProgress(90_000, byDay, "2026-10-11")?.reachedOn, "2026-10-05");
  is("no goal, nothing to show", goalProgress(0, byDay, "2026-10-11"), null);

  part("Records");
  const quiet: Record<string, number> = {};
  for (let i = 10; i < 80; i += 7) quiet[day("2026-07-14", i)] = 2000;
  is("a new store's first sales are not called records", recordsFrom({ direct: { "2026-10-10": 5000 } }, "2026-10-11"), { bestDay: null, bestWeek: null });
  is("a best day of the last 90, set this week", recordsFrom({ direct: { ...quiet, "2026-10-09": 9000 } }, "2026-10-11"), { bestDay: { day: "2026-10-09", cents: 9000 }, bestWeek: { cents: 9000 } });
  is("a best day long ago is no news", recordsFrom({ direct: { ...quiet, "2026-07-30": 9000 } }, "2026-10-11").bestDay, null);

  part("Said in words");
  const days = Array.from({ length: 90 }, (_, i) => ({ date: day("2026-07-14", i), visitors: 10, views: 12, checkouts: 1, sales: 0 }));
  const zero = { visitors: 0, views: 0, checkouts: 0, sales: 0, cents: 0 };
  const empty = { d7: [], d30: [], d90: [] };
  const data = {
    days,
    totals: { d7: { ...zero, visitors: 70 }, d30: { ...zero, visitors: 300 }, d90: { ...zero, visitors: 900 }, all: zero },
    sources: { d7: [], d30: [], d90: [], all: [] },
    mediums: { d7: [], d30: [], d90: [], all: [] },
    campaigns: { d7: [], d30: [], d90: [], all: [] },
    products: [],
    links: [],
    sales: "ok",
    partial: false,
    currency: "usd",
    elsewhere: 0,
    since: "",
    revenueBySource: [],
    firstBySource: [],
    channels: {
      d7: [{ source: "instagram", visits: 40, checkouts: 5, free: 0, sales: 3, cents: 30_000 }, { source: "tiktok", visits: 30, checkouts: 1, free: 0, sales: 0, cents: 0 }],
      d30: [],
      d90: [],
    },
    posts: empty,
    countries: { d7: [], d30: [], d90: [], all: [] },
    devices: { d7: [], d30: [], d90: [], all: [] },
    renewals: null,
    reach: { d7: { visitors: 0, rows: [] }, d30: { visitors: 0, rows: [] }, d90: { visitors: 0, rows: [] } },
    previous: { d7: { visitors: 0, views: 0, checkouts: 0, sales: null, cents: null }, d30: { visitors: 0, views: 0, checkouts: 0, sales: null, cents: null }, d90: { visitors: 0, views: 0, checkouts: 0, sales: null, cents: null } },
    heard: empty,
    searchMisses: empty,
    ads: empty,
    salesCountries: empty,
    refunds: null,
    refundsByProduct: {},
    channelDays: { instagram: { ...quiet, "2026-09-03": 7000, "2026-10-09": 30_000 } },
  } as unknown as StatsData;
  const adSpends: AdSpend[] = [
    { id: "a", channel: "instagram", campaign: "", cents: 10_000, from: "2026-10-05", to: "2026-10-11" },
    { id: "b", channel: "tiktok", campaign: "", cents: 5_000, from: "2026-10-05", to: "2026-10-11" },
  ];
  data.cashflowComplete = true;
  data.refunds = { d7: [], d30: [], d90: [] };
  const said = insightsFrom(data, "d7", adSpends, 6).map((i) => i.text);
  is("a channel's recorded payments less costs, not a budget instruction", said.some((t) => /^Instagram received \$300 in payments in the last 7 days, with \$0 in refunds and \$100 in recorded ads\. \$200 remains before fees and other costs\.$/.test(t)), true);
  is("a channel with spend and no payments discloses the negative result", said.some((t) => /^TikTok received \$0 in payments in the last 7 days, with \$0 in refunds and \$50 in recorded ads\. -\$50 remains before fees and other costs\.$/.test(t)), true);
  is("no direction to scale or cut follows from gross attributed sales", said.some((t) => /spending more|worth cutting/.test(t)), false);
  is("and the record, said as of the last 90 days", said.some((t) => /best 7 days of the last 90/.test(t)), true);
  const week = weeklyMessage(store, data, "https://marktmorgen.com/stop", [], 300_000)!;
  is("the Monday email carries the goal", /October goal: \$300 of \$3,000 \(10%\), \$135 a day needed for the 20 days left\./.test(week.text), true);
  is("the month just ended is the one before today", lastMonthOf(Date.parse("2026-10-01T09:00:00Z")), "2026-09");
  const month = monthlyMessage(store, data, "2026-09", "https://marktmorgen.com/stop", 5_000)!;
  is("a goal set on the 1st is not held against the month before it, only against its own and after", [goalForMonth({ cents: 300_000, since: "2026-10" }, "2026-09"), goalForMonth({ cents: 300_000, since: "2026-10" }, "2026-10"), goalForMonth({ cents: 300_000, since: "2026-08" }, "2026-09")], [0, 300_000, 300_000]);
  is("the month's email: its visitors set beside the month before, its money, its best day and the goal", [
    month.subject,
    /Visitors: 300 \(down 3\.2% on the month before\)/.test(month.text),
    /Money from sales and renewals: \$150 before/.test(month.text),
    /Best day: Thursday, September 3, \$70\./.test(month.text),
    /Your goal of \$50 was reached: 300%\./.test(month.text),
    /To stop it, the weekly one and the busy-day one: https:\/\/marktmorgen\.com\/stop/.test(month.text),
  ], ["Harbor Kitchen in September 2026: $150 in sales and renewals", true, true, true, true, true]);
  is("a month with nobody and nothing says nothing", monthlyMessage(store, { ...data, days: [], channelDays: {} }, "2026-09", "x"), null);

  part("Slack and Discord");
  is("only a Slack or Discord webhook address is taken", [chatKind(SLACK), chatKind(DISCORD), chatKind("https://example.com/hook"), chatKind("http://hooks.slack.com/services/T0000/B0000/abcdefghijk"), chatKind("https://discord.com.evil.io/api/webhooks/123456/abcdefghijklmnopqrstuvwxyz")], ["slack", "discord", null, null, null]);
  is("anything else is refused before a request is made", [await setChatAddress(store.statsId!, "Harbor Kitchen", "https://127.0.0.1/x"), posted.length], ["invalid", 0]);
  chatAnswers = 404;
  is("an address the chat will not post to is not kept", [await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK), await chatSetup(store.statsId)], ["refused", null]);
  chatAnswers = 200;
  is("one that took a first message is kept", [await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK), await chatSetup(store.statsId), await chatAddress(store.statsId)], ["saved", "slack", SLACK]);
  const [kept] = await redisPipeline([["GET", `nl:chatsum:${store.statsId}`]]);
  is("sealed, never as given", [typeof kept, String(kept).includes("hooks.slack.com")], ["string", false]);
  is("Slack's marks escaped, so a name cannot ping a channel", chatBody("slack", "<!channel> & co"), { text: "&lt;!channel&gt; &amp; co" });
  is("Discord pings nobody and stays under its length", [chatBody("discord", "@everyone").allowed_mentions, String(chatBody("discord", "x".repeat(3000)).content).length], [{ parse: [] }, 1986]);
  is("the email's lines about stopping it are not posted", forChat("Sales: 3\n\nYou get this every Monday while your store has visitors. To stop it: https://x"), "Sales: 3");
  is("kept by the store, not by its address, so another store with the same handle never reaches the channel", [await chatAddress("harbor"), await chatAddress(null)], [null, null]);
  is("forgotten when emptied", [await setChatAddress(store.statsId!, "Harbor Kitchen", ""), await chatSetup(store.statsId)], ["removed", null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
