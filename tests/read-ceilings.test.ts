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
 * (A product update's reading is held by tests/product-update-ceiling.test.ts.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_BUILDS_PER_DAY, CALENDAR_FILE_MAX_BYTES, CALENDAR_MAX_EVENTS, CALENDAR_POLLS_PER_HOUR, CALENDAR_REFRESH_SECONDS,
  bookedCalendar, bookedCalendarFeed, keptSlots, newFeedToken,
} from "@/lib/calendar-sync";
import { planReminders } from "@/lib/call-records";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import {
  CALENDAR_BUILD_SHAPE, CALENDAR_POLL_SHAPE, CALENDAR_STRIPE_PAGES, LIFE_FILL_SHAPE, TOTALS_STORE_SHAPE, TOTALS_STORE_UNITS,
  UPDATE_READ_SHAPE, UPDATE_READ_UNITS,
} from "@/lib/read-ceilings";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { takeAllowance } from "@/lib/store-allowance";
import { readNumbers } from "@/lib/stats-report";
import { COST_LINES, PER_PAYMENT_LINES, UNIT_COST, readShapeCost } from "./plan-cost-registry";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const OWNER = "feed@example.com";

let stripeReads = 0;
let stripeDown = false;
globalThis.fetch = (async () => {
  stripeReads += 1;
  if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** Commands the database is sent while `work` runs. */
async function counted<T>(work: () => Promise<T>): Promise<{ value: T; commands: number }> {
  const real = redis.pipeline;
  let commands = 0;
  redis.pipeline = async (batch) => {
    commands += batch.length;
    return real(batch);
  };
  try {
    return { value: await work(), commands };
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
  const url = (await newFeedToken(store)).subscribeUrl ?? "";
  const token = url.slice(url.lastIndexOf("/") + 1);
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
  const owner = { statsId: store.statsId as string, handle: store.handle };
  await planReminders(store.callsId ?? "calls1", store.handle, "cs_test_feed000001", Date.now() + 3 * 86_400_000);
  const readsBeforeChange = stripeReads;
  const remade = await bookedCalendarFeed(owner, async () => {
    stripeReads += 1;
    return "BEGIN:VCALENDAR\r\nX-REMADE:1\r\nEND:VCALENDAR";
  }, Date.now() + 3_600_000);
  is("a booking made since: the next hour's answer makes the file again", [remade.state, stripeReads > readsBeforeChange], ["made", true]);

  part("Made again a few times a day at most, and the copy stands when it cannot be");
  const day = Date.UTC(2031, 0, 6, 0, 30);
  let makings = 0;
  const make = async () => {
    makings += 1;
    if (stripeDown) throw new Error("Stripe did not answer");
    return `BEGIN:VCALENDAR\r\nX-MADE:${makings}\r\nEND:VCALENDAR`;
  };
  const answers: string[] = [];
  for (let hour = 0; hour < CALENDAR_BUILDS_PER_DAY + 3; hour += 1) {
    const now = day + hour * 3_600_000;
    await planReminders("calls1", store.handle, `cs_test_feed00000${hour}`, now + 3 * 86_400_000, now);
    answers.push((await bookedCalendarFeed(owner, make, now + 1_000)).state);
  }
  is(`a booking changed every hour: made ${CALENDAR_BUILDS_PER_DAY} times that day, then the copy`, [makings, answers.filter((a) => a === "made").length, answers.slice(-3)], [CALENDAR_BUILDS_PER_DAY, CALENDAR_BUILDS_PER_DAY, ["copy", "copy", "copy"]]);
  const nextDay = day + 86_400_000 + 7 * 3_600_000;
  is("the next day the copy has grown old: made again", [(await bookedCalendarFeed(owner, make, nextDay)).state, makings], ["made", CALENDAR_BUILDS_PER_DAY + 1]);
  is("an hour on, nothing changed and the copy young: the copy, nothing made", [(await bookedCalendarFeed(owner, make, nextDay + 3_600_000)).state, makings], ["copy", CALENDAR_BUILDS_PER_DAY + 1]);
  stripeDown = true;
  const old = nextDay + (CALENDAR_REFRESH_SECONDS + 3_600) * 1000;
  const failed = await bookedCalendarFeed(owner, make, old);
  is("the copy grown old and Stripe down: the copy is answered, not an error", [failed.state, "ics" in failed && failed.ics.includes("X-MADE:")], ["copy", true]);
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`]);
  const none = await bookedCalendarFeed(owner, make, old + 3_600_000).then((a) => a.state, () => "failed");
  is("no copy at all and Stripe down: the route answers 503, asking the app to come back", [none, read("app/api/store/calendar/[token]/route.ts").includes("return later(503, 300);")], ["failed", true]);
  stripeDown = false;

  part("A deleted store's copy is never answered again (M2)");
  const later = old + 5 * 3_600_000;
  is("before: the copy is answered", (await bookedCalendarFeed(owner, make, later)).state, "made");
  redis.run(["SET", `nl:store:handle:${owner.handle}`, `released:${new Date().toISOString()}`]);
  is("the store deleted (its handle let go): gone at once, the copy kept or not", (await bookedCalendarFeed(owner, make, later + 60_000)).state, "gone");
  is("the route answers 404 for it", read("app/api/store/calendar/[token]/route.ts").includes('if (answer.state === "gone") return missing();'), true);
  redis.run(["SET", `nl:store:handle:${owner.handle}`, OWNER]);

  part("Each count keeps its expiry, and the copy has a size (L3, L4)");
  const paceKey = `nl:cal:pace:${owner.statsId}:${Math.floor((later + 7_200_000) / 3_600_000)}`;
  redis.run(["SET", paceKey, "0"]);
  await bookedCalendarFeed(owner, make, later + 7_200_000);
  is("a count found without an expiry gets one back", Number(redis.run(["TTL", paceKey])) > 0, true);
  const huge = async () => `BEGIN:VCALENDAR\r\n${"X".repeat(CALENDAR_FILE_MAX_BYTES)}\r\nEND:VCALENDAR`;
  redis.run(["DEL", `nl:cal:out:${owner.statsId}`]);
  const oversized = await bookedCalendarFeed(owner, huge, later + 3 * 3_600_000);
  is("a file past its ceiling is neither kept nor sent", [oversized.state, redis.run(["GET", `nl:cal:out:${owner.statsId}`])], ["none", null]);

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
  is("each booking's moves, room reads and room making are counted in the build (M1)", CALENDAR_BUILD_SHAPE.commands >= 2 + (1 + 4 + 2) * CALENDAR_STRIPE_PAGES * 100, true);

  part("Every figure costs at least the worst it stands for");
  const held: [string, number, number, number][] = [
    ["a product update's reading of every sale", UPDATE_READ_UNITS, UNIT_COST.studio, readShapeCost(UPDATE_READ_SHAPE)],
    ["one store's numbers on the totals page", TOTALS_STORE_UNITS, UNIT_COST.studio, readShapeCost(TOTALS_STORE_SHAPE)],
  ];
  for (const [what, units, each, worst] of held) {
    is(`${what}: ${units} units at $${each.toFixed(6)} cover $${worst.toFixed(6)}`, units * each >= worst, true);
  }
  is("a totals reading costs more than a page, so it is no longer the page's units", TOTALS_STORE_UNITS >= STUDIO_PAGE_UNITS, true);
  const fill = PER_PAYMENT_LINES.find((l) => l.id === "stats-life-fill");
  is("a store's one-time all-time filling has its own line, once for each store (M4)", (fill?.monthlyUsd("creator") ?? 0) >= readShapeCost(LIFE_FILL_SHAPE), true);
  const line = COST_LINES.find((l) => l.id === "calendar-feed");
  const feedMonth = line ? line.monthlyUsd("creator") : 0;
  is("the feed is a cost line of its own, every making and answer of the month at its worst", feedMonth >= 32 * CALENDAR_BUILDS_PER_DAY * readShapeCost(CALENDAR_BUILD_SHAPE) + 31 * 24 * CALENDAR_POLLS_PER_HOUR * readShapeCost(CALENDAR_POLL_SHAPE), true);
  console.log(`  calendar feed: a making $${readShapeCost(CALENDAR_BUILD_SHAPE).toFixed(6)}, an answer $${readShapeCost(CALENDAR_POLL_SHAPE).toFixed(6)}, the month $${feedMonth.toFixed(4)}`);
  console.log(`  its own once-a-store line (stats-life-fill): a store's first all-time filling $${readShapeCost(LIFE_FILL_SHAPE).toFixed(4)} once (${LIFE_FILL_SHAPE.commands} commands)`);

  part("The totals page: one store's numbers, read within their count");
  redis.run(["HSET", `nl:stats:${owner.statsId}:life`, "filled", "2031-01-01", "since", "2031-01-01", "vgap", "0"]);
  const reading = await counted(() => readNumbers(store));
  is(`one store's numbers make no more commands than TOTALS_STORE_SHAPE counts (${reading.commands} <= ${TOTALS_STORE_SHAPE.commands})`, reading.commands <= TOTALS_STORE_SHAPE.commands, true);
  const totals = read("app/studio/totals/page.tsx");
  is("each store's numbers, this page's store's too, take their units before they are read", [totals.indexOf("countStudio(store, null, TOTALS_STORE_UNITS)") >= 0 && totals.indexOf("countStudio(store, null, TOTALS_STORE_UNITS)") < totals.indexOf("readNumbers(store)"), totals.includes("alreadyCounted")], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
