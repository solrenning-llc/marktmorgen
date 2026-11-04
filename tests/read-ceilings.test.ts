/**
 * Three reads, each paid for before it reads anything (C4-4, 4 November 2026;
 * owner's rule MR: a ceiling before every spend, an unknown cost never zero).
 * The community search is Claude 3's (C4-6). What is checked, by behaviour,
 * with the in-memory database and a stand-in for Stripe:
 *
 *   - the private booking calendar answers a calendar app from the last good
 *     copy of its file and never spends the creator's studio requests; the
 *     file is made again only after a booking changed or once the copy is old,
 *     at most CALENDAR_BUILDS_PER_DAY a day, counted before Stripe is read;
 *     past that, and when Stripe fails, the copy is answered (never 503 while
 *     one exists); a feed asked more than CALENDAR_POLLS_PER_HOUR times an
 *     hour is asked to come back, reading nothing; the file keeps the events
 *     still to come first;
 *   - every unit of lib/read-ceilings.ts costs at least the worst it stands
 *     for, priced with the registry's own rates, and the calendar's own cost
 *     line is in the registry;
 *   - the totals page's reading of one store's numbers makes no more
 *     commands than TOTALS_STORE_SHAPE counts, and it takes its units first.
 *
 * (A product update's search for its buyers is counted in the studio's requests,
 *  lib/product-updates.ts updateReadUnits, held by tests/ledger-counted-callers.test.ts.)
 */
import { MAX_PAID_BYTES, PAYPAL_REFUNDS_READ } from "@/lib/paypal-sales";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_BUILDS_PER_DAY, CALENDAR_CREDITS_PER_DAY, CALENDAR_RETRIES_PER_DAY, CALENDAR_FILE_MAX_BYTES, CALENDAR_MAX_EVENTS, CALENDAR_POLLS_PER_HOUR, CALENDAR_REFRESH_SECONDS, CALENDAR_REFUSED_PER_HOUR,
  FeedGone, bookedCalendar, bookedCalendarFeed, calendarView, ensureFeedToken, forgetStoreCalendar, keptSlots, newFeedToken, storeIdForToken,
} from "@/lib/calendar-sync";
import { planReminders } from "@/lib/call-records";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import {
  CALENDAR_BUILD_PER_BOOKING, CALENDAR_BUILD_SHAPE, CALENDAR_POLL_SHAPE, CALENDAR_STRIPE_PAGES, LIFE_FILL_SHAPE, MEMBERS_READ_SHAPE, SALES_READ_SHAPE, STATS_READ_SHAPE,
  CALENDAR_REFUSED_SHAPE, KEPT_READINGS_SHAPE, READING_COUNT_COMMANDS, SINCE_READ_SHAPE, STORE_READING_SHAPES, calendarBuildCommands,
} from "@/lib/read-ceilings";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { HEAVY_READINGS_PER_DAY, SINCE_READINGS_PER_DAY, STORE_READINGS_PER_DAY, ReadingsUsed, keptNumbers, readingsLeft, takeStoreReading } from "@/lib/store-readings";
import { GB, STORAGE_PER_GB, providerFeeUsd, worstCost } from "./plan-cost-model";
import { PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { claimHandle, createStore, ensureStatsId, renameHandle, setStripeAccount, setSubscription, storeForEmail, storeForHandle, storeForId, type Store } from "@/lib/store";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { takeAllowance } from "@/lib/store-allowance";
import { COST_LINES, PER_PAYMENT_LINES, nonPayingWorst, readShapeCost } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const OWNER = "feed@example.com";

let stripeReads = 0;
let stripeDown = false;
/** Booked calls the stand-in for Stripe lists, for a measured making. */
let callSessions: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  stripeReads += 1;
  if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  const data = String(input).includes("/checkout/sessions") ? callSessions : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }));
}) as typeof fetch;

/** Commands the database is sent while `work` runs. */
async function counted<T>(work: () => Promise<T>): Promise<{ value: T; commands: number; widest: number }> {
  const real = redis.pipeline;
  let commands = 0;
  let widest = 0;
  redis.pipeline = async (batch) => {
    commands += batch.length;
    for (const command of batch) widest = Math.max(widest, command.length - 1);
    return real(batch);
  };
  try {
    return { value: await work(), commands, widest };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_feed_only_a_stand_in";
  await claimHandle(OWNER, "feeder", "Feeder Calls", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFeeder0001", true);
  await setSubscription(OWNER, { customerId: "cus_Feeder00001", subscriptionId: "sub_Feeder00001", active: true, tier: "pro", period: paidPeriod() });
  const load = async () => (await storeForEmail(OWNER))!;
  const store = await load();
  let url = (await newFeedToken(store)).subscribeUrl ?? "";
  let token = url.slice(url.lastIndexOf("/") + 1);
  const ask = () => feedRoute(new Request(url), { params: Promise.resolve({ token }) });
  const studioLeft = async () => {
    const taken = await takeAllowance(await load(), "studio", 1);
    return taken.ok ? taken.left : -1;
  };

  part("The booking calendar answers from its last good copy, never from the studio's requests");
  const before = await studioLeft();
  const first = await ask();
  const readsAfterFirst = stripeReads;
  is("the first answer makes the file, reading Stripe", [first.status, (await first.text()).startsWith("BEGIN:VCALENDAR"), readsAfterFirst > 0], [200, true, true]);
  const second = await ask();
  is("the next answers it from the copy, reading nothing from Stripe", [second.status, stripeReads - readsAfterFirst], [200, 0]);
  is("and neither took a single studio request", before - (await studioLeft()), 1);
  for (let n = 2; n < CALENDAR_POLLS_PER_HOUR; n += 1) await ask();
  const readsBeforePaced = stripeReads;
  const paced = await ask();
  is(`past ${CALENDAR_POLLS_PER_HOUR} answers in an hour the app is asked to come back, and nothing is read`, [paced.status, paced.headers.get("Retry-After"), stripeReads - readsBeforePaced], [429, "900", 0]);
  const CALLS = "c".repeat(32);
  const owner = { statsId: store.statsId as string, handle: store.handle, callsId: CALLS };

  part("A sliding hour: an app asking late in an hour is not refused for the next one (light c)");
  {
    const slide = { ...owner, statsId: "slidestore" };
    redis.run(["SET", `nl:store:handle:${slide.handle}`, OWNER]);
    const t = Date.UTC(2031, 0, 5, 10, 50);
    const quick = async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
    const states: string[] = [];
    for (let i = 0; i < CALENDAR_POLLS_PER_HOUR + 1; i += 1) states.push((await bookedCalendarFeed(slide, quick, t + i * 60_000)).state);
    is(`within sixty minutes, the ${CALENDAR_POLLS_PER_HOUR + 1}th is refused`, states[CALENDAR_POLLS_PER_HOUR], "paced");
    is("just past the hour, at 11:10 (not 12:00), answered again", (await bookedCalendarFeed(slide, quick, t + 61 * 60_000)).state === "paced", false);
    const refusedSet = Number(redis.run(["ZCARD", "nl:cal:pace:slidestore"]));
    is("a refusal is taken back from the count", refusedSet <= CALENDAR_POLLS_PER_HOUR, true);
  }

  part("Made again a few times a day at most, each booking that day with its own credit (M3), and the copy stands when it cannot be");
  const day = Date.UTC(2031, 0, 6, 0, 30);
  let makings = 0;
  const make = async () => {
    makings += 1;
    if (stripeDown) throw new Error("Stripe did not answer");
    return `BEGIN:VCALENDAR\r\nX-MADE:${makings}\r\nEND:VCALENDAR`;
  };
  // The day's own makings, spent on two refreshes with nothing booked.
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`]);
  await bookedCalendarFeed(owner, make, day);
  await bookedCalendarFeed(owner, make, day + (CALENDAR_REFRESH_SECONDS + 60) * 1000);
  const ownMade = makings;
  const answers: string[] = [];
  for (let n = 0; n < CALENDAR_CREDITS_PER_DAY + 2; n += 1) {
    const now = day + (CALENDAR_REFRESH_SECONDS + 120) * 1000 + n * 20 * 60_000;
    await planReminders(CALLS, store.handle, `cs_test_feed00000${n}`, now + 3 * 86_400_000, now);
    answers.push((await bookedCalendarFeed(owner, make, now + 1_000)).state);
  }
  is(`the day's own ${CALENDAR_BUILDS_PER_DAY} makings spent, then a booking each: made for the first ${CALENDAR_CREDITS_PER_DAY} (the fifth among them), then the copy`, [ownMade, answers.slice(0, CALENDAR_CREDITS_PER_DAY).every((a) => a === "made"), answers[4], answers.slice(CALENDAR_CREDITS_PER_DAY)], [CALENDAR_BUILDS_PER_DAY, true, "made", ["copy", "copy"]]);
  const nextDay = day + 86_400_000 + 7 * 3_600_000;
  is("the next day the copy has grown old: made again", [(await bookedCalendarFeed(owner, make, nextDay)).state], ["made"]);
  const madeBefore = makings;
  is("an hour on, nothing changed and the copy young: the copy, nothing made", [(await bookedCalendarFeed(owner, make, nextDay + 3_600_000)).state, makings], ["copy", madeBefore]);
  stripeDown = true;
  const old = nextDay + (CALENDAR_REFRESH_SECONDS + 3_600) * 1000;
  const failed = await bookedCalendarFeed(owner, make, old);
  is("the copy grown old and Stripe down: the copy is answered, not an error", [failed.state, "ics" in failed && failed.ics.includes("X-MADE:")], ["copy", true]);
  // No copy at all and Stripe down: the route itself answers 503, asking the app to come back.
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`, `nl:cal:pace:${owner.statsId}`]);
  const unavailable = await ask();
  is("no copy at all and Stripe down: the route answers 503", [unavailable.status, unavailable.headers.get("Retry-After")], [503, "300"]);
  stripeDown = false;

  part("A making that fails is given back once a day; the second failure that day stays counted (inbox C4-53)");
  {
    const retryDay = Date.UTC(2032, 6, 1, 9, 0);
    const d = new Date(retryDay).toISOString().slice(0, 10);
    const builds = `nl:cal:builds:${owner.statsId}:${d}`;
    redis.run(["DEL", `nl:cal:out:${owner.statsId}`, `nl:cal:pace:${owner.statsId}`, `${builds}:r`]);
    // One of the day's own makings left.
    redis.run(["SET", builds, String(CALENDAR_BUILDS_PER_DAY - 1), "EX", 2 * 86_400]);
    stripeDown = true;
    const first = await bookedCalendarFeed(owner, make, retryDay).then((a) => a.state, () => "error");
    const afterFirst = Number(redis.run(["GET", builds]));
    const second = await bookedCalendarFeed(owner, make, retryDay + 60_000).then((a) => a.state, () => "error");
    const afterSecond = Number(redis.run(["GET", builds]));
    stripeDown = false;
    const third = await bookedCalendarFeed(owner, make, retryDay + 120_000);
    is(`the first failure gives its making back (${CALENDAR_RETRIES_PER_DAY} a day): the day still has one`, [first, afterFirst], ["error", CALENDAR_BUILDS_PER_DAY - 1]);
    is("the second failure that day is counted: the day's makings are used", [second, afterSecond], ["error", CALENDAR_BUILDS_PER_DAY]);
    is("so with Stripe back, nothing is made until the next day", third.state, "none");
    is("the given-back count never goes below zero", afterFirst >= 0 && afterSecond >= 0, true);
    redis.run(["DEL", `nl:cal:pace:${owner.statsId}`]);
    const idle = await counted(() => bookedCalendarFeed(owner, make, retryDay + 180_000));
    is("with no making left, an answer takes no count: the pace and one MGET", [idle.value.state, idle.commands <= 5 + 1], ["none", true]);
    const triesDay = Date.UTC(2032, 6, 2, 9, 0);
    const td = new Date(triesDay).toISOString().slice(0, 10);
    redis.run(["DEL", `nl:cal:pace:${owner.statsId}`]);
    redis.run(["SET", `nl:cal:builds:${owner.statsId}:${td}:a`, String(CALENDAR_BUILDS_PER_DAY + CALENDAR_CREDITS_PER_DAY), "EX", 86_400]);
    const capped = await bookedCalendarFeed(owner, make, triesDay);
    is(`the day's tries, made or failed, never pass the ${CALENDAR_BUILDS_PER_DAY + CALENDAR_CREDITS_PER_DAY} priced makings, own makings left or not`, [capped.state, Number(redis.run(["GET", `nl:cal:builds:${owner.statsId}:${td}`]) ?? 0)], ["none", 0]);
  }

  part("A deleted store's copy is never answered again (M2), by the route itself");
  redis.run(["DEL", `nl:cal:pace:${owner.statsId}`, `nl:cal:builds:${owner.statsId}:${new Date().toISOString().slice(0, 10)}`]);
  is("before: the route answers the file", (await ask()).status, 200);
  redis.run(["SET", `nl:store:handle:${owner.handle}`, `released:${new Date().toISOString()}`]);
  const routeGone = await ask();
  is("the store deleted (its handle let go): the route answers 404, and the copy is gone", [routeGone.status, redis.run(["GET", `nl:cal:out:${owner.statsId}`])], [404, null]);
  redis.run(["SET", `nl:store:handle:${owner.handle}`, OWNER]);
  const later = old + 5 * 3_600_000;

  part("Each count keeps its expiry, and the copy has a size (L3, L4)");
  const buildsKey = `nl:cal:builds:${owner.statsId}:${new Date(later + 7_200_000).toISOString().slice(0, 10)}`;
  redis.run(["SET", buildsKey, "0"]);
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`]);
  await bookedCalendarFeed(owner, make, later + 7_200_000);
  is("a count found without an expiry gets one back", Number(redis.run(["TTL", buildsKey])) > 0, true);
  const huge = async () => `BEGIN:VCALENDAR\r\n${"X".repeat(CALENDAR_FILE_MAX_BYTES)}\r\nEND:VCALENDAR`;
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`]);
  const oversized = await bookedCalendarFeed(owner, huge, later + 30 * 3_600_000);
  is("a file past its ceiling is neither kept nor sent", [oversized.state, redis.run(["GET", `nl:cal:out:${owner.statsId}`])], ["none", null]);

  part("A new address keeps the last copy (light a)");
  await bookedCalendarFeed(owner, make, later + 60 * 3_600_000);
  const keptBefore = redis.run(["GET", `nl:cal:out:${owner.statsId}`]);
  url = (await newFeedToken(await load())).subscribeUrl ?? "";
  token = url.slice(url.lastIndexOf("/") + 1);
  is("the copy is still there for the new address", [keptBefore !== null, redis.run(["GET", `nl:cal:out:${owner.statsId}`]) === keptBefore], [true, true]);

  part("Refusals have a ceiling: past CALENDAR_REFUSED_PER_HOUR in an hour the address stops, and the studio says so (C4-33, light a)");
  {
    // Later than any answer above, and from an hour with nothing in it yet.
    const at = Date.UTC(2033, 0, 9, 10, 0);
    redis.run(["DEL", `nl:cal:pace:${owner.statsId}`, `nl:cal:refused:${owner.statsId}`]);
    const quick = async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
    url = (await calendarView(await load())).subscribeUrl ?? "";
    token = url.slice(url.lastIndexOf("/") + 1).replace(/\.ics$/, "");
    const asked = { ...owner, token };
    const states: string[] = [];
    for (let i = 0; i < CALENDAR_POLLS_PER_HOUR + CALENDAR_REFUSED_PER_HOUR; i += 1) states.push((await bookedCalendarFeed(asked, quick, at + i * 1_000)).state);
    is(`the ${CALENDAR_REFUSED_PER_HOUR} refusals the line prices leave the address as it is`, [states.filter((x) => x === "paced").length, (await storeIdForToken(token))?.statsId], [CALENDAR_REFUSED_PER_HOUR, owner.statsId]);
    const one = await counted(() => bookedCalendarFeed(asked, quick, at + 60_000));
    is("the refusal that stops it: the pace, its count and the stop, within a refused shape and the stop priced as one more (its token's two reads aside)", [one.value.state, one.commands <= CALENDAR_REFUSED_SHAPE.commands - 2 + 4], ["paced", true]);
    is("one more: the address is let go", await storeIdForToken(token), null);
    const stopped = await calendarView(await load());
    is("the studio shows no address and says it was stopped, with when", [stopped.subscribeUrl, typeof stopped.stoppedAt === "string" && Date.parse(stopped.stoppedAt) === at + 60_000], [null, true]);
    await ensureFeedToken(await load());
    const made = await calendarView(await load());
    is("the studio makes a new one in its place and keeps saying why", [made.subscribeUrl !== null && made.subscribeUrl !== url, made.stoppedAt !== null], [true, true]);
    url = (await newFeedToken(await load())).subscribeUrl ?? "";
    token = url.slice(url.lastIndexOf("/") + 1).replace(/\.ics$/, "");
    is("a new address the creator asks for clears the note", (await calendarView(await load())).stoppedAt, null);
    const editor = read("components/calendar-editor.tsx");
    is("the editor says the rule and how to keep the address: every 15 minutes or less often", editor.includes("Set your app to check every 15 minutes or less often") && editor.includes("view.stoppedAt ?"), true);
  }

  part("The file keeps what is still to come first");
  const now = Date.now();
  const slots = [
    ...Array.from({ length: CALENDAR_MAX_EVENTS }, (_, i) => ({ start: now - (i + 2) * 600_000, end: now - (i + 1) * 600_000, id: `past${i}` })),
    ...Array.from({ length: 30 }, (_, i) => ({ start: now + (i + 1) * 3_600_000, end: now + (i + 1) * 3_600_000 + 1_800_000, id: `next${i}` })),
  ];
  const kept = keptSlots(slots, now);
  is("every event still to come is kept, then the latest past ones", [kept.length, kept.filter((s) => s.id.startsWith("next")).length, kept.some((s) => s.id === "past0"), kept.some((s) => s.id === `past${CALENDAR_MAX_EVENTS - 1}`)], [CALENDAR_MAX_EVENTS, 30, true, false]);
  const many = Array.from({ length: CALENDAR_MAX_EVENTS + 25 }, (_, i) => ({
    session: `cs_${i}`, start: now + 86_400_000 + i * 3_600_000, end: now + 86_400_000 + i * 3_600_000 + 1_800_000, product: "p1", title: "Call", email: `b${i}@example.com`, name: null,
    buyerTz: "UTC", moves: 0, answers: [], amount: 0, currency: "usd", hosts: [], claim: "", lead: "", pi: "", due: null, cancel: null,
  }));
  const ics = bookedCalendar({ name: "Feeder", handle: "feeder", catalog: { items: [], head: [], inline: [] } } as unknown as Store, many as never, now, []);
  is("the file holds at most CALENDAR_MAX_EVENTS events, the soonest", [ics.split("BEGIN:VEVENT").length - 1, ics.includes("b0@example.com"), ics.includes(`b${CALENDAR_MAX_EVENTS}@example.com`)], [CALENDAR_MAX_EVENTS, true, false]);
  is("the build's Stripe pages are lib/calls.ts's own", read("lib/calls.ts").includes(`const MAX_PAGES = ${CALENDAR_STRIPE_PAGES};`), true);

  part("A real making, measured, within its count (M1, light d)");
  {
    // The route's own making, through Stripe pages of booked calls: what it sends the database, for 10 and 40 bookings.
    const sessionsOf = (n: number) => Array.from({ length: n }, (_, i) => ({
      id: `cs_test_measure${String(i).padStart(6, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
      created: Math.floor(Date.now() / 1000) - 3_600, amount_total: 5000, currency: "usd", customer_details: { email: `m${i}@example.com`, name: `M ${i}` },
      metadata: { store: store.handle, kind: "call", product: "nolisting", start: String(Date.now() + (i + 1) * 86_400_000), end: String(Date.now() + (i + 1) * 86_400_000 + 1_800_000) },
      payment_intent: { id: `pi_${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    }));
    const measure = async (n: number) => {
      callSessions = sessionsOf(n);
      redis.run(["DEL", `nl:cal:out:${owner.statsId}`, `nl:cal:pace:${owner.statsId}`]);
      redis.run(["DEL", `nl:cal:builds:${owner.statsId}:${new Date().toISOString().slice(0, 10)}`]);
      const m = await counted(() => ask());
      return m.commands;
    };
    const ten = await measure(10);
    const forty = await measure(40);
    callSessions = [];
    const perBooking = (forty - ten) / 30;
    is(`each booking adds what the count gives it (${perBooking.toFixed(2)} <= ${CALENDAR_BUILD_PER_BOOKING})`, perBooking <= CALENDAR_BUILD_PER_BOOKING, true);
    is(`forty bookings, measured (${forty}), within the count for forty (${calendarBuildCommands(0, 40) + CALENDAR_POLL_SHAPE.commands})`, forty <= calendarBuildCommands(0, 40) + CALENDAR_POLL_SHAPE.commands, true);
    // Measured, not the shape's own expression again (review C4-33 (c)): the fixed part measured here, with every
    // listing (one GET each) and every booking at the measured rate, is within the shape.
    const fixedMeasured = forty - 40 * perBooking - CALENDAR_POLL_SHAPE.commands;
    is(`the shape holds the measured fixed part (${fixedMeasured.toFixed(0)}), every listing and every booking at its worst`, CALENDAR_BUILD_SHAPE.commands >= fixedMeasured + MAX_PRODUCTS + perBooking * CALENDAR_STRIPE_PAGES * 100, true);
  }

  part("Every figure costs at least the worst it stands for");
  const fill = PER_PAYMENT_LINES.find((l) => l.id === "stats-life-fill");
  is("a store's one-time all-time filling has its own line, once for each store (M4)", (fill?.monthlyUsd("creator") ?? 0) >= readShapeCost(LIFE_FILL_SHAPE), true);
  const line = COST_LINES.find((l) => l.id === "calendar-feed");
  const feedMonth = line ? line.monthlyUsd("creator") : 0;
  is("the feed is a cost line of its own, every try of a making (its own and its credits, a failure given back included) and answer of the month at its worst", feedMonth >= 32 * (CALENDAR_BUILDS_PER_DAY + CALENDAR_CREDITS_PER_DAY) * readShapeCost(CALENDAR_BUILD_SHAPE) + 31 * 24 * CALENDAR_POLLS_PER_HOUR * readShapeCost(CALENDAR_POLL_SHAPE), true);
  const readings = COST_LINES.find((l) => l.id === "store-readings");
  const readingsMonth = readings ? readings.monthlyUsd("creator") : 0;
  const heavyWorst = readShapeCost(SALES_READ_SHAPE);
  const lightWorst = Math.max(readShapeCost(STATS_READ_SHAPE), readShapeCost(MEMBERS_READ_SHAPE));
  is("every light shape is lighter than the heavy ones it is counted apart from", lightWorst <= heavyWorst && STORE_READING_SHAPES.length === 3, true);
  is("the store's readings are a line of their own, every reading of every day at the dearest of its kind (heavy, light, brought up to date)", readingsMonth >= 32 * (HEAVY_READINGS_PER_DAY * heavyWorst + (STORE_READINGS_PER_DAY - HEAVY_READINGS_PER_DAY) * lightWorst + SINCE_READINGS_PER_DAY * readShapeCost(SINCE_READ_SHAPE)), true);
  {
    // Inbox C4-33 (1): the day's heavy readings are the most the margin allows, with the room that exists: the first
    // payment refunded in full (tests/plan-margin.test.ts, under US$ 65, a ceiling the owner keeps) stays under it,
    // and one more heavy reading a day would pass it. Computed as that test computes it.
    const keptToClosing = (paidStorageBytes("creator") / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
    const year = worstCost("creator") + providerFeeUsd(PRICES_WITHOUT_COMMISSION.creator.year) + keptToClosing;
    const oneMoreHeavy = 32 * (heavyWorst - lightWorst);
    const oneMoreSince = 32 * readShapeCost(SINCE_READ_SHAPE);
    is("the first year given back stays under US$ 65 with the day's sales readings, whole and brought up to date", year < 65, true);
    is("one more whole reading a day would pass it", year + oneMoreHeavy >= 65, true);
    is("and one more brought up to date: both figures are the most the margin allows (C4-36 (B), C4-41 (f))", year + oneMoreSince >= 65, true);
    is("together, at least one an hour (inbox C4-33 (1))", HEAVY_READINGS_PER_DAY + SINCE_READINGS_PER_DAY >= 24, true);
    is("a reading brought up to date costs a fraction of a whole one", readShapeCost(SINCE_READ_SHAPE) < heavyWorst / 4, true);
  }
  {
    // The day's heavy readings stop at their own figure; light ones go on to the day's whole figure.
    const probe = { statsId: "h".repeat(32) };
    const at = Date.parse("2031-02-03T10:00:00Z");
    const heavy: boolean[] = [];
    for (let i = 0; i < HEAVY_READINGS_PER_DAY + 1; i += 1) heavy.push(await takeStoreReading(probe, at, true));
    const light: boolean[] = [];
    for (let i = 0; i < STORE_READINGS_PER_DAY; i += 1) light.push(await takeStoreReading(probe, at));
    is("heavy readings stop at HEAVY_READINGS_PER_DAY, and a refused one is not counted", [heavy.filter(Boolean).length, light.filter(Boolean).length], [HEAVY_READINGS_PER_DAY, STORE_READINGS_PER_DAY - HEAVY_READINGS_PER_DAY]);
    // C4-33 (b): the count's commands measured, against what the shapes price.
    const fresh = { statsId: "m".repeat(32) };
    const day = Date.parse("2031-02-04T10:00:00Z");
    const lightTaken = await counted(() => takeStoreReading(fresh, day));
    const heavyTaken = await counted(() => takeStoreReading(fresh, day, true));
    redis.run(["SET", `nl:reading:day:${fresh.statsId}:2031-02-04`, String(STORE_READINGS_PER_DAY), "EX", 86_400]);
    const lightRefused = await counted(() => takeStoreReading(fresh, day));
    const heavyRefused = await counted(() => takeStoreReading(fresh, day, true));
    is("a reading's count, measured: light 3, heavy 5, as READING_COUNT_COMMANDS less its GET and SET", [lightTaken.commands, heavyTaken.commands, lightTaken.value && heavyTaken.value], [READING_COUNT_COMMANDS.light - 2, READING_COUNT_COMMANDS.heavy - 2, true]);
    is("refused, with its DECRBY: light 4, heavy 7, inside what KEPT_READINGS_SHAPE prices for a page that reads nothing", [lightRefused.commands, heavyRefused.commands, lightRefused.value || heavyRefused.value, 3 + 2 * lightRefused.commands + heavyRefused.commands + 2 <= KEPT_READINGS_SHAPE.commands], [4, 7, false, true]);
    const left = await counted(() => readingsLeft(fresh, day));
    is("what is left of the day: three GET; the readings used, the sales still brought up to date after the day's whole one", [left.commands, left.value.any, left.value.heavy, left.value.heavyLeft], [3, false, true, SINCE_READINGS_PER_DAY]);
    redis.run(["SET", `nl:reading:day:${fresh.statsId}:2031-02-04:since`, String(SINCE_READINGS_PER_DAY), "EX", 86_400]);
    is("and none left once those are used too", await readingsLeft(fresh, day), { any: false, heavy: false, anyLeft: 0, heavyLeft: 0 });
  }
  is("a store in its trial or past its plan keeps both, priced for it (M2)", nonPayingWorst() >= feedMonth + readingsMonth, true);
  console.log(`  calendar feed: a making $${readShapeCost(CALENDAR_BUILD_SHAPE).toFixed(6)}, an answer $${readShapeCost(CALENDAR_POLL_SHAPE).toFixed(6)}, the month $${feedMonth.toFixed(4)}`);
  console.log(`  store readings: a reading at most $${Math.max(...STORE_READING_SHAPES.map(readShapeCost)).toFixed(6)}, the month $${readingsMonth.toFixed(4)}`);
  console.log(`  its own once-a-store line (stats-life-fill): a store's first all-time filling $${readShapeCost(LIFE_FILL_SHAPE).toFixed(4)} once (${LIFE_FILL_SHAPE.commands} commands)`);

  part("The totals: a page of each store's studio, as the Terms say; its numbers from its own readings (M1)");
  redis.run(["HSET", `nl:stats:${owner.statsId}:life`, "filled", "2031-01-01", "since", "2031-01-01", "vgap", "0"]);
  // At its worst: more refunded PayPal orders than one reading takes (PAYPAL_REFUNDS_READ), read in one MGET.
  for (let i = 0; i < PAYPAL_REFUNDS_READ + 1; i += 1) {
    const order = `ORDER${String(i).padStart(8, "0")}`;
    redis.run(["ZADD", `nl:ppsell:refunded:${owner.statsId}`, Math.floor(Date.now() / 1000) - 60, order]);
    redis.run(["SET", `nl:ppsell:paid:${order}`, JSON.stringify({ store: owner.statsId, order, capture: `CAP${i}`, email: "", product: "p", cents: 100, currency: "usd", at: 1 })]);
  }
  const loaded = await load();
  const full = await counted(() => keptNumbers(loaded));
  const fullBound = STATS_READ_SHAPE.commands + SALES_READ_SHAPE.commands;
  // The refunded orders' records are read in one MGET (lib/paypal-sales.ts): the worst is reached when one command carries as many as a reading takes.
  is(`one store's visits and sales at the worst refunds (one command of ${full.widest} keys), measured (${full.commands}), within their readings' count (${fullBound})`, [full.widest >= PAYPAL_REFUNDS_READ, full.commands <= fullBound], [true, true]);
  // And every record those reads may move, PayPal sales and refunds alike (both kept as nl:ppsell:paid:), at the most it weighs.
  is("the sales reading's bytes hold every PayPal record it reads at its heaviest", SALES_READ_SHAPE.dbBytes >= (20 * 100 + PAYPAL_REFUNDS_READ) * MAX_PAID_BYTES, true);
  const again = await counted(() => keptNumbers(loaded));
  is("looked at again within the fresh time: read from what was kept, a few commands", again.commands <= 3 + 1, true);
  const studioBefore = await studioLeft();
  redis.run(["SET", `nl:reading:day:${owner.statsId}:${new Date().toISOString().slice(0, 10)}`, String(STORE_READINGS_PER_DAY), "EX", 86_400]);
  redis.run(["DEL", `nl:reading:stats:${owner.statsId}`, `nl:reading:sales:${owner.statsId}`]);
  const spent = await keptNumbers(await load()).then(() => "read", (error: unknown) => (error instanceof ReadingsUsed ? "used" : String(error)));
  is("the day's readings used and nothing kept: nothing read, said as used (never as no numbers), and no studio request taken for it", [spent, studioBefore - (await studioLeft())], ["used", 1]);
  const totals0 = () => read("app/studio/totals/page.tsx");
  is("the totals say a store so left out comes back at 00:00 UTC, on the reader's clock too (C4-33 (3))", totals0().includes('if (error instanceof ReadingsUsed) return { state: "used" };') && totals0().includes("<UtcAndLocal ms={readingsBackAt()} />"), true);
  const totals = read("app/studio/totals/page.tsx");
  is("the page takes a page of each other store's studio and nothing more", [totals.includes("countStudio(store, null, STUDIO_PAGE_UNITS)"), totals.includes("keptNumbers(store)"), totals.includes("TOTALS_STORE_UNITS")], [true, true, false]);

  part("A handle taken by another store never brings the old copy back (M2-bis)");
  {
    redis.clear();
    const ONE = "first@example.com";
    const TWO = "second@example.com";
    await claimHandle(ONE, "takenback", "First Store", "");
    await ensureStatsId(ONE);
    await setStripeAccount(ONE, "acct_1TestFirst00001", true);
    await setSubscription(ONE, { customerId: "cus_First000001", subscriptionId: "sub_First000001", active: true, tier: "pro", period: paidPeriod() });
    const firstStore = (await storeForEmail(ONE))!;
    const firstFeed = (await newFeedToken(firstStore)).subscribeUrl ?? "";
    const firstToken = firstFeed.slice(firstFeed.lastIndexOf("/") + 1).replace(/\.ics$/, "");
    const feedOwner = (await storeIdForToken(firstToken))!;
    // As the route makes it: the store behind the handle, refused when it is not the feed's.
    const asRoute = async () => {
      const behind = await storeForHandle(feedOwner.handle);
      if (!behind || behind.statsId !== feedOwner.statsId) throw new FeedGone();
      return "BEGIN:VCALENDAR\r\nX-WHO:first\r\nEND:VCALENDAR";
    };
    const t0 = Date.UTC(2032, 2, 1, 0, 30);
    is("the first store's copy is made", (await bookedCalendarFeed(feedOwner, asRoute, t0)).state, "made");
    // Deleted without its feed forgotten (as before this fix), the handle held back, then taken by another account's store.
    redis.run(["SET", `nl:store:handle:${feedOwner.handle}`, `released:${new Date(t0).toISOString()}`]);
    const goneAnswer = await counted(() => bookedCalendarFeed(feedOwner, asRoute, t0 + 3_600_000));
    is("deleted: gone, and the copy, which names buyers, deleted at once (light 1)", [goneAnswer.value.state, redis.run(["GET", `nl:cal:out:${feedOwner.statsId}`])], ["gone", null]);
    // The token and its settings are read by the route before the feed (2 GET): with the feed's own, within the answer's count (light 5).
    is(`that answer's commands, with the token's two, within CALENDAR_POLL_SHAPE (${goneAnswer.commands + 2} <= ${CALENDAR_POLL_SHAPE.commands})`, goneAnswer.commands + 2 <= CALENDAR_POLL_SHAPE.commands, true);
    redis.run(["DEL", `nl:store:handle:${feedOwner.handle}`]);
    await claimHandle(TWO, "takenback", "Second Store", "");
    await ensureStatsId(TWO);
    const states: string[] = [];
    for (let n = 0; n < 6; n += 1) states.push((await bookedCalendarFeed(feedOwner, asRoute, t0 + 86_400_000 + n * 3_600_000)).state);
    is("the handle taken by another store: every answer is 404, the fifth too, and never the old copy", [states[4], states.every((s) => s === "gone")], ["gone", true]);
    const tomb = String(redis.run(["GET", `nl:cal:out:${feedOwner.statsId}`]) ?? "");
    is("and nothing of the old copy is kept, nor anyone's address in its place (light e)", [tomb.includes("X-WHO"), tomb.includes("@"), tomb], [false, false, JSON.stringify({ gone: true })]);
    // The day's makings already spent when the handle is taken: still never the copy.
    redis.run(["SET", `nl:cal:out:${feedOwner.statsId}`, JSON.stringify({ at: t0, ics: "BEGIN:VCALENDAR\r\nX-WHO:first\r\nEND:VCALENDAR", ref: ONE })]);
    const day3 = t0 + 2 * 86_400_000;
    redis.run(["SET", `nl:cal:builds:${feedOwner.statsId}:${new Date(day3).toISOString().slice(0, 10)}`, String(CALENDAR_BUILDS_PER_DAY), "EX", 86_400]);
    const spent = await bookedCalendarFeed(feedOwner, asRoute, day3);
    is("with the day's makings spent, the old copy is not answered either", [spent.state, "ics" in spent], ["none", false]);

    part("A renamed store keeps its feed (L-c)");
    await claimHandle("third@example.com", "renamedfrom", "Third Store", "");
    await ensureStatsId("third@example.com");
    const third = (await storeForEmail("third@example.com"))!;
    const thirdUrl = (await newFeedToken(third)).subscribeUrl ?? "";
    const thirdOwner = (await storeIdForToken(thirdUrl.slice(thirdUrl.lastIndexOf("/") + 1).replace(/\.ics$/, "")))!;
    const thirdMake = async () => {
      const behind = await storeForHandle(thirdOwner.handle);
      if (!behind || behind.statsId !== thirdOwner.statsId) throw new FeedGone();
      return "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
    };
    const renamed = await renameHandle("third@example.com", "renamedto");
    is("renamed", renamed.ok, true);
    is("its feed, still under the old handle in its settings, answers: no 404 by mistake", (await bookedCalendarFeed(thirdOwner, thirdMake, t0)).state, "made");
    // Light b: its bookings' changes are kept by the store's calls id, which the rename did not change.
    const withCalls = { ...thirdOwner, callsId: "d".repeat(32) };
    is("the copy, young and unchanged", (await bookedCalendarFeed(withCalls, thirdMake, t0 + 60_000)).state, "copy");
    await planReminders(withCalls.callsId, "renamedto", "cs_test_renamed0001", t0 + 5 * 86_400_000, t0 + 120_000);
    is("a booking marked under the new handle is read by the calls id: made again at once", (await bookedCalendarFeed(withCalls, thirdMake, t0 + 180_000)).state, "made");

    part("A copy is kept only by the store that made it (light 3)");
    const third0 = Date.UTC(2032, 3, 1, 0, 30);
    const copyKey = `nl:cal:out:${thirdOwner.statsId}`;
    const madeCopy = JSON.parse(String(redis.run(["GET", copyKey]))) as { ref?: string; sid?: string };
    is("it names what the handle led to and the store's own id", [typeof madeCopy.ref, madeCopy.sid], ["string", thirdOwner.statsId]);
    redis.run(["SET", copyKey, JSON.stringify({ ...madeCopy, at: third0, ics: "BEGIN:VCALENDAR\r\nX-WHO:other\r\nEND:VCALENDAR", sid: "someone-else" })]);
    redis.run(["SET", `nl:cal:builds:${thirdOwner.statsId}:${new Date(third0).toISOString().slice(0, 10)}`, String(CALENDAR_BUILDS_PER_DAY), "EX", 86_400]);
    const wrongSid = await bookedCalendarFeed(thirdOwner, thirdMake, third0 + 60_000);
    is("a copy that names another store's id is not answered", [wrongSid.state, "ics" in wrongSid], ["none", false]);

    part("A deletion while the file is being made is not undone (light 2)");
    const racing = await bookedCalendarFeed(thirdOwner, async () => {
      // The store is deleted from the studio while its file is being made.
      await forgetStoreCalendar(thirdOwner.statsId);
      return "BEGIN:VCALENDAR\r\nX-WHO:raced\r\nEND:VCALENDAR";
    }, third0 + 2 * 86_400_000);
    // Inbox C4-48, medium 1: the deletion won the race, so what was made is not answered either, and no copy is written.
    is("the file made is neither answered nor kept: the feed is gone", [racing.state, "ics" in racing, redis.run(["GET", copyKey])], ["gone", false, null]);
  }

  part("A store deleted from the studio forgets its feed at once (M2-bis, 1; light 6)");
  {
    const OWNS = "owns@example.com";
    await claimHandle(OWNS, "ownsfirst", "Owns First", "");
    await ensureStatsId(OWNS);
    const extra = await createStore(OWNS, "ownsextra", "Owns Extra", "");
    if (!extra.ok) throw new Error(`no extra store: ${JSON.stringify(extra)}`);
    const extraStore = (await storeForId(extra.store.sid))!;
    const extraUrl = (await newFeedToken(extraStore)).subscribeUrl ?? "";
    const extraToken = extraUrl.slice(extraUrl.lastIndexOf("/") + 1).replace(/\.ics$/, "");
    const extraOwner = (await storeIdForToken(extraToken))!;
    await bookedCalendarFeed(extraOwner, async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR", Date.UTC(2032, 5, 1, 0, 30));
    const before = ["cfg", "out"].map((k) => redis.run(["GET", `nl:cal:${k}:${extraOwner.statsId}`]) !== null);
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNS)}`;
    const form = new FormData();
    form.set("action", "delete");
    form.set("confirm", "ownsextra");
    const response = await storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": extra.store.sid }, body: form }));
    is("the studio's delete answers by going back to the studio", [response.status, response.headers.get("Location")?.includes("stores=deleted")], [303, true]);
    is("before: its settings and its copy were kept", before, [true, true]);
    is("after: its settings, its copy and its address are gone", [redis.run(["GET", `nl:cal:cfg:${extraOwner.statsId}`]), redis.run(["GET", `nl:cal:out:${extraOwner.statsId}`]), await storeIdForToken(extraToken)], [null, null, null]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
