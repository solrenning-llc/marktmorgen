/**
 * A store's kept reading of its sales (lib/store-readings.ts) names its
 * biggest buyers by their address. A person's erasure, by the real door
 * (lib/person-erasure.ts, erasePerson), takes that copy with it: nothing kept
 * names them afterwards (inbox C4-48, the Codex E review of #2111). The next
 * reading is made again from the store's Stripe account, which keeps the
 * purchase (lib/person-data.ts). The calendar feed's copy, which names who
 * booked, goes the same way.
 *
 * What fails here: the copy still holding the address after the erasure, or
 * the erasure not listing the readings among what it forgot.
 */
import { normaliseEmail } from "@/lib/auth";
import { type Store, storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { keptReading, keptSales, withoutErasedBuyers } from "@/lib/store-readings";
import { CALENDAR_BUILDS_PER_DAY, bookedCalendar, bookedCalendarFeed, ensureFeedToken, newFeedToken, withoutErasedBookers } from "@/lib/calendar-sync";
import { suppressCommand } from "@/lib/suppression";
import { setStripeAccount } from "@/lib/store";
import { GET as feedRoute } from "@/app/api/store/calendar/[token]/route";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_readings_erasure_only";
/** The checkouts the stand-in for Stripe lists (the races below); none otherwise. */
let checkouts: Record<string, unknown>[] = [];
/** Run once while Stripe lists the checkouts (a person's erasure while a reading is being made), then let go. */
let whileListing: (() => Promise<unknown>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const listing = String(input).includes("/checkout/sessions?") && (init?.method ?? "GET") === "GET";
  if (listing && whileListing) {
    const run = whileListing;
    whileListing = null;
    await run();
  }
  return new Response(JSON.stringify({ object: "list", data: listing ? checkouts : [], has_more: false }), { status: 200 });
}) as typeof fetch;

/**
 * `work`, with the person's erasure (the real door) run whole right after the
 * first look among the store's deleted people (the HMGET of nl:erased) and
 * before anything else the work sends: the race of a reading begun before the
 * erasure and kept after it (review of #2111).
 */
/**
 * The order a review found (of fe4cb5e56): the erasure's print written right
 * after the look among the deleted people, the copy's own step run, and only
 * then the rest of the erasure, whose DEL finds no copy left.
 */
async function printThenErased<T>(store: Store, email: string, work: () => Promise<T>): Promise<T> {
  const real = redis.pipeline;
  let printed = false;
  let erased = false;
  redis.pipeline = async (batch) => {
    const answer = await real(batch);
    if (!printed && batch.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${store.listId}`)) {
      printed = true;
      await real([suppressCommand(store.listId as string, email)]);
    } else if (printed && !erased && batch.some((c) => c[0] === "EVAL")) {
      erased = true;
      redis.pipeline = real;
      await erasePerson(store, email, { kind: "person" });
    }
    return answer;
  };
  try {
    return await work();
  } finally {
    redis.pipeline = real;
  }
}

async function erasedDuring<T>(store: Store, email: string, work: () => Promise<T>): Promise<{ value: T; raced: boolean }> {
  const real = redis.pipeline;
  let raced = false;
  redis.pipeline = async (batch) => {
    const answer = await real(batch);
    if (!raced && batch.some((c) => c[0] === "HMGET" && c[1] === `nl:erased:${store.listId}`)) {
      raced = true;
      redis.pipeline = real;
      await erasePerson(store, email, { kind: "person" });
    }
    return answer;
  };
  try {
    return { value: await work(), raced };
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld("readings-erasure");
  const person = normaliseEmail("rhea.reader@example.com");
  const other = normaliseEmail("otto.other@example.com");
  await seedPerson(world, other, null);
  await seedPerson(world, person, other);
  const store = (await storeForEmail(OWNER))!;
  const key = `nl:reading:sales:${store.statsId}`;

  part("A kept sales reading that names the person");
  const sales = { biggestBuyers: [{ email: person, cents: 4_900 }, { email: other, cents: 2_900 }] };
  const kept = await keptReading(store, "sales", async () => sales, Date.now(), true);
  is("the reading is kept, naming them", JSON.stringify(kept?.value ?? null).includes(person), true);
  is("and it is in the database", String(redis.run(["GET", key]) ?? "").includes(person), true);

  const membersKey = `nl:reading:members:${store.statsId}`;
  const feedKey = `nl:cal:out:${store.statsId}`;
  // What members wrote when they left, and the feed's kept file naming who booked (the review of #2111).
  redis.run(["SET", membersKey, JSON.stringify({ at: Date.now(), value: { leaving: { recent: [`${person} wrote: too expensive`] } } }), "EX", 86_400]);
  redis.run(["SET", feedKey, JSON.stringify({ at: Date.now(), ics: `BEGIN:VCALENDAR\r\nATTENDEE;CN=Rhea:mailto:${person}\r\nEND:VCALENDAR`, ref: "x", sid: store.statsId }), "EX", 86_400]);

  // The day's own makings of the feed used, so the erasure's making given back is what lets the file be made again.
  const buildsKey = `nl:cal:builds:${store.statsId}:${new Date().toISOString().slice(0, 10)}`;
  redis.run(["SET", buildsKey, "2", "EX", 86_400]);

  part("The person's erasure, by the real door");
  const erased = await erasePerson(store, person, { kind: "person" });
  is("the erasure ends", erased.ok, true);
  is("nothing kept of the store's readings names them", String(redis.run(["GET", key]) ?? "").includes(person), false);
  is("nor the kept memberships reading, nor the calendar feed's file", [redis.run(["GET", membersKey]), redis.run(["GET", feedKey])], [null, null]);
  is("and one of the day's makings given back, so the next check makes the file again", Number(redis.run(["GET", buildsKey])), 1);
  is("the calendar feed's copy is among what it forgot", erased.ok ? erased.parts.some((p) => p.module === "lib/calendar-sync.ts") : false, true);
  is("the readings are among what it forgot", erased.ok ? erased.parts.some((p) => p.module === "lib/store-readings.ts") : false, true);

  part("Read again from Stripe, which keeps the purchase and the booking: the person is not named again (review of #2111)");
  const readAgain = await keptReading(store, "sales", () => withoutErasedBuyers(store, { buyers: { top: sales.biggestBuyers.map((b) => ({ email: b.email, cents: b.cents, orders: 1, last: 0, reference: "" })) } }), Date.now(), true);
  const keptNow = String(redis.run(["GET", key]) ?? "");
  is("the next sales reading leaves them out of the biggest buyers, and keeps the others", [JSON.stringify(readAgain?.value).includes(person), keptNow.includes(person), keptNow.includes(other)], [false, false, true]);
  is("the studio's sales reading goes through it", readFileSync("lib/store-readings.ts", "utf8").includes("return withoutErasedBuyers({ listId: guard.listId ?? null }, sales);"), true);
  const calls = [
    { session: "cs_1", start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, product: "p1", email: person, name: "Rhea Reader", moves: 0 },
    { session: "cs_2", start: Date.now() + 2 * 86_400_000, end: Date.now() + 2 * 86_400_000 + 3_600_000, product: "p1", email: other, name: "Otto Other", moves: 0 },
  ];
  const unnamed = await withoutErasedBookers(store, calls);
  const ics = bookedCalendar(store, unnamed, Date.now(), []);
  is("the calendar file made again keeps the booked time but does not name them", [ics.includes(person), ics.includes("Rhea"), ics.includes("A buyer whose details were deleted"), ics.includes(other)], [false, false, true, true]);
  is("the feed's route goes through it", readFileSync("app/api/store/calendar/[token]/route.ts", "utf8").includes("const calls = store.listId ? await withoutErasedBookers(store, paid)"), true);

  part("A sales reading begun before a buyer's erasure keeps nothing naming them (the race, review of #2111)");
  const day = new Date().toISOString().slice(0, 10);
  const freshDay = () => redis.run(["DEL", `nl:reading:day:${store.statsId}:${day}`, `nl:reading:day:${store.statsId}:${day}:heavy`]);
  const selling = { ...store, stripeAccountId: "acct_test_readings_race" } as Store;
  const checkout = (email: string, cents: number, i: number) => ({
    id: `cs_test_race${String(i).padStart(8, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 3_600 - i, amount_total: cents, currency: store.currency, customer_details: { email, name: email.split("@")[0] },
    metadata: { store: store.handle, product: "p1" }, payment_intent: `pi_test_race${i}`,
  });
  const racer = normaliseEmail("rae.racer@example.com");
  const stayer = normaliseEmail("sam.stayer@example.com");
  checkouts = [checkout(racer, 9_900, 1), checkout(stayer, 1_900, 2)];
  freshDay();
  redis.run(["DEL", key]);
  const plain = await keptSales(selling, Date.now(), true);
  is("no race: the reading names both biggest buyers and is kept so", [JSON.stringify(plain.value).includes(racer), String(redis.run(["GET", key]) ?? "").includes(racer), String(redis.run(["GET", key]) ?? "").includes(stayer)], [true, true, true]);
  freshDay();
  const raced = await erasedDuring(selling, racer, () => keptSales(selling, Date.now(), true));
  is("the erasure ran between the look among the deleted people and the copy kept", raced.raced, true);
  is("afterwards no copy kept names them", String(redis.run(["GET", key]) ?? "").includes(racer), false);
  is("nor does the reading shown", JSON.stringify(raced.value.value).includes(racer), false);
  freshDay();
  const next = await keptSales(selling, Date.now(), true);
  const keptAfter = String(redis.run(["GET", key]) ?? "");
  is("the next reading is not blocked: made again, without them, the others kept", [next.stale, JSON.stringify(next.value).includes(racer), keptAfter.includes(racer), keptAfter.includes(stayer)], [false, false, false, true]);

  freshDay();
  redis.run(["DEL", key]);
  const realPipeline = redis.pipeline;
  redis.pipeline = async (batch) => {
    if (batch.some((c) => c[0] === "EVAL")) throw new Error("the step could not be run");
    return realPipeline(batch);
  };
  const unchecked = await keptSales(selling, Date.now(), true).finally(() => {
    redis.pipeline = realPipeline;
  });
  is("when the step that checks and keeps cannot run, nothing is kept (its check could not be made), and the reading is shown", [redis.run(["GET", key]), unchecked.value?.buyers?.top.length], [null, 1]);

  part("A calendar file begun before a booker's erasure is neither kept nor answered naming them (the race, review of #2111)");
  checkouts = [];
  await ensureFeedToken(store);
  const owner = { statsId: store.statsId!, handle: store.handle, callsId: null };
  const freshFeed = () => redis.run(["DEL", feedKey, `nl:cal:pace:${store.statsId}`, buildsKey, `${buildsKey}:a`, `${buildsKey}:c`, `${buildsKey}:r`]);
  const booker = normaliseEmail("bo.booker@example.com");
  const guest = normaliseEmail("gus.guest@example.com");
  const booked = [
    { session: "cs_b1", start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, product: "p1", email: booker, name: "Bo Booker", moves: 0 },
    { session: "cs_b2", start: Date.now() + 2 * 86_400_000, end: Date.now() + 2 * 86_400_000 + 3_600_000, product: "p1", email: guest, name: "Gus Guest", moves: 0 },
  ];
  // The route's own making (app/api/store/calendar/[token]/route.ts): its bookers looked up among the deleted people, then the file.
  const making = async () => {
    const calls = await withoutErasedBookers(store, booked);
    return { ics: bookedCalendar(store, calls, Date.now(), []), listId: store.listId, named: calls.map((c) => c.email).filter((e): e is string => Boolean(e)) };
  };
  freshFeed();
  const quiet = await bookedCalendarFeed(owner, making);
  is("no race: the file is made, answered and kept, naming both", [quiet.state, String(redis.run(["GET", feedKey]) ?? "").includes(booker), String(redis.run(["GET", feedKey]) ?? "").includes(guest)], ["made", true, true]);
  freshFeed();
  const feedRace = await erasedDuring(store, booker, () => bookedCalendarFeed(owner, making));
  is("the erasure ran between the look among the deleted people and the copy kept", feedRace.raced, true);
  is("afterwards nothing kept names them", String(redis.run(["GET", feedKey]) ?? "").includes(booker), false);
  is("and the answer is not the file naming them: none, the app asks again", [feedRace.value.state, JSON.stringify(feedRace.value).includes(booker)], ["none", false]);

  part("The race the review found: the copy's step runs before the erasure's DEL, and takes the day's last own making (review of fe4cb5e56)");
  const late = normaliseEmail("lee.late@example.com");
  const lateBooked = [...booked.slice(1), { ...booked[0], session: "cs_b3", email: late, name: "Lee Late" }];
  const lateMaking = async () => {
    const calls = await withoutErasedBookers(store, lateBooked);
    return { ics: bookedCalendar(store, calls, Date.now(), []), listId: store.listId, named: calls.map((c) => c.email).filter((e): e is string => Boolean(e)) };
  };
  freshFeed();
  const at = Date.now();
  is("made once today, naming them", [(await bookedCalendarFeed(owner, lateMaking, at)).state, String(redis.run(["GET", feedKey]) ?? "").includes(late), Number(redis.run(["GET", buildsKey]))], ["made", true, 1]);
  // The copy grown older than its refresh, so the next check makes it again with the day's last own making.
  const aged = JSON.parse(String(redis.run(["GET", feedKey])));
  redis.run(["SET", feedKey, JSON.stringify({ ...aged, at: at - 13 * 3_600_000 }), "EX", 86_400]);
  redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
  const split = await printThenErased(store, late, () => bookedCalendarFeed(owner, lateMaking, at + 1));
  is("the copy's step found their print: nothing answered, nothing kept naming them", [split.state, String(redis.run(["GET", feedKey]) ?? "").includes(late)], ["none", false]);
  is(`the day's own makings are not left used up by it (${CALENDAR_BUILDS_PER_DAY} a day)`, Number(redis.run(["GET", buildsKey])) < CALENDAR_BUILDS_PER_DAY, true);
  redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
  const after = await bookedCalendarFeed(owner, lateMaking, at + 2);
  is("the app's next check makes the file again, without them, and keeps it", [after.state, JSON.stringify(after).includes(late), String(redis.run(["GET", feedKey]) ?? "").includes(guest), String(redis.run(["GET", feedKey]) ?? "").includes(late)], ["made", false, true, false]);

  part("A making that cannot look the bookers up where it keeps the copy (no list) answers the file but keeps nothing naming them");
  freshFeed();
  const listless = await bookedCalendarFeed(owner, async () => ({ ics: `BEGIN:VCALENDAR\r\nATTENDEE:mailto:${guest}\r\nEND:VCALENDAR`, listId: null, named: [guest] }), at + 3);
  is("answered, not kept", [listless.state, redis.run(["GET", feedKey])], ["made", null]);
  redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
  const nobody = await bookedCalendarFeed(owner, async () => ({ ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR", listId: null, named: [] }), at + 4);
  is("a file naming nobody is kept as before", [nobody.state, redis.run(["GET", feedKey]) !== null], ["made", true]);

  part("The feed's real route passes who the file names and the store's list to the step that keeps it (review of fe4cb5e56)");
  await setStripeAccount(OWNER, "acct_test_readings_feed", true);
  const routed = (await storeForEmail(OWNER))!;
  const url = (await newFeedToken(routed)).subscribeUrl ?? "";
  const token = url.slice(url.lastIndexOf("/") + 1);
  const ask = () => feedRoute(new Request(url), { params: Promise.resolve({ token }) });
  const callSession = (email: string, i: number) => ({
    id: `cs_test_feedcall${String(i).padStart(6, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 3_600, amount_total: 5000, currency: "usd", customer_details: { email, name: email.split("@")[0] },
    metadata: { store: routed.handle, kind: "call", product: "nolisting", start: String(Date.now() + (i + 1) * 86_400_000), end: String(Date.now() + (i + 1) * 86_400_000 + 1_800_000) },
    payment_intent: { id: `pi_feedcall${i}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  });
  const caller = normaliseEmail("cal.caller@example.com");
  const keeper = normaliseEmail("kay.keeper@example.com");
  checkouts = [callSession(caller, 1), callSession(keeper, 2)];
  freshFeed();
  const routeQuiet = await ask();
  const routeQuietText = await routeQuiet.text();
  is("no race: the route answers the file naming both and keeps it", [routeQuiet.status, routeQuietText.includes(caller), String(redis.run(["GET", feedKey]) ?? "").includes(caller)], [200, true, true]);
  freshFeed();
  const routeRace = await erasedDuring(routed, caller, ask);
  const routeRaceText = await routeRace.value.text();
  is("the erasure ran between the route's look among the deleted people and the copy kept", routeRace.raced, true);
  is("the route's answer does not name them, and nothing kept does", [routeRace.value.status === 200 && routeRaceText.includes(caller), String(redis.run(["GET", feedKey]) ?? "").includes(caller)], [false, false]);

  part("A store kept from before it had a list: its list is made before anyone is named, so the check where the copy is kept can be made (review of fe4cb5e56)");
  // Its record as a store from before #1680 had it: no list.
  const ownerKey = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${OWNER.toLowerCase()}`).digest("hex").slice(0, 40)}`;
  const record = JSON.parse(String(redis.run(["GET", ownerKey])));
  is("the record found", record.handle, routed.handle);
  const unlisted = () => redis.run(["SET", ownerKey, JSON.stringify({ ...record, listId: null })]);
  unlisted();
  const sayer = normaliseEmail("sal.sayer@example.com");
  checkouts = [callSession(sayer, 3), callSession(keeper, 4)];
  freshFeed();
  // The person's erasure while Stripe is read (it makes the store's list for their print).
  whileListing = async () => erasePerson((await storeForEmail(OWNER))!, sayer, { kind: "person" });
  const listlessRoute = await ask();
  const listlessText = await listlessRoute.text();
  is("the route's file does not name them, nor anything kept", [listlessText.includes(sayer), String(redis.run(["GET", feedKey]) ?? "").includes(sayer)], [false, false]);
  is("and the store has a list now", typeof (await storeForEmail(OWNER))?.listId, "string");

  unlisted();
  const unlistedStore = { ...(await storeForEmail(OWNER))!, stripeAccountId: "acct_test_readings_race" } as Store;
  const saleSayer = normaliseEmail("sue.sales@example.com");
  checkouts = [checkout(saleSayer, 9_900, 5), checkout(stayer, 1_900, 6)];
  freshDay();
  redis.run(["DEL", key]);
  whileListing = async () => erasePerson((await storeForEmail(OWNER))!, saleSayer, { kind: "person" });
  const listlessSales = await keptSales(unlistedStore, Date.now(), true);
  is("a sales reading of a store with no list: neither shown nor kept naming them", [JSON.stringify(listlessSales.value).includes(saleSayer), String(redis.run(["GET", key]) ?? "").includes(saleSayer)], [false, false]);
  unlisted();
  freshDay();
  redis.run(["DEL", key, `nl:list:try:${store.statsId}:${day}`]);
  const quietSales = await keptSales({ ...unlistedStore }, Date.now(), true);
  is("with nobody deleted, its list is made and the reading kept as before", [String(redis.run(["GET", key]) ?? "").includes(stayer), typeof (await storeForEmail(OWNER))?.listId, quietSales.stale], [true, "string", false]);

  part("A store from before lists whose list cannot be made (its record's lock stays busy): tried once a day, and a copy that names nobody is kept (review of 2c1af02e0)");
  unlisted();
  const lockKey = ownerKey.replace("nl:store:owner:", "nl:store:lock:");
  redis.run(["SET", lockKey, "held-by-another-write", "EX", 3_600]);
  const listTry = `nl:list:try:${store.statsId}:${day}`;
  // The parts above may have taken today's try; this store is read here as on a new day.
  redis.run(["DEL", listTry]);
  /** How many of `work`'s commands tried the store's lock. */
  const lockTries = async <T>(work: () => Promise<T>): Promise<{ value: T | Error; tries: number }> => {
    const real = redis.pipeline;
    let tries = 0;
    redis.pipeline = async (batch) => {
      tries += batch.filter((c) => c[0] === "SET" && c[1] === lockKey).length;
      return real(batch);
    };
    try {
      return { value: await work(), tries };
    } catch (error) {
      return { value: error as Error, tries };
    } finally {
      redis.pipeline = real;
    }
  };
  const busyStore = { ...(await storeForEmail(OWNER))!, stripeAccountId: "acct_test_readings_race" } as Store;
  is("the store has no list and its record is moved to product records", [busyStore.listId, Boolean(busyStore.catalog.id)], [null, true]);
  const shy = normaliseEmail("shy.buyer@example.com");
  const bold = normaliseEmail("bold.buyer@example.com");
  checkouts = [checkout(shy, 9_900, 7), checkout(bold, 1_900, 8)];
  freshDay();
  redis.run(["DEL", key]);
  const salesTries: number[] = [];
  const salesStates: string[] = [];
  let salesShown = "";
  for (let i = 0; i < 4; i += 1) {
    const one = await lockTries(() => keptSales(busyStore, Date.now() + i, true));
    salesTries.push(one.tries);
    salesStates.push(one.value instanceof Error ? one.value.constructor.name : one.value.stale ? "kept" : "read");
    if (!(one.value instanceof Error)) salesShown += JSON.stringify(one.value.value);
  }
  const salesKept = String(redis.run(["GET", key]) ?? "");
  is(`its list tried in one reading of the day, not in each (${JSON.stringify(salesTries)})`, salesTries.filter((n) => n > 0).length, 1);
  is(`the numbers still shown on every call, from the copy kept once the day's readings are used (${JSON.stringify(salesStates)})`, salesStates.includes("ReadingsUsed"), false);
  is("a copy is kept, with its totals, naming nobody", [salesKept !== "", /"cents":\d/.test(salesKept), salesKept.includes(shy), salesKept.includes(bold)], [true, true, false, false]);
  is("and nothing shown names them either", [salesShown.includes(shy), salesShown.includes(bold)], [false, false]);

  redis.run(["DEL", listTry]);
  const shyCaller = normaliseEmail("shy.caller@example.com");
  checkouts = [callSession(shyCaller, 5), callSession(bold, 6)];
  freshFeed();
  const feedTries: number[] = [];
  const feedAnswers: number[] = [];
  let feedShown = "";
  for (let i = 0; i < 4; i += 1) {
    redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
    const one = await lockTries(ask);
    feedTries.push(one.tries);
    const response = one.value as Response;
    feedAnswers.push(response.status);
    feedShown += await response.text();
  }
  const feedKept = String(redis.run(["GET", feedKey]) ?? "");
  is(`the feed tries its list in one making of the day, not in each (${JSON.stringify(feedTries)})`, feedTries.filter((n) => n > 0).length, 1);
  is(`every check answered with a file, none asked to come back (${JSON.stringify(feedAnswers)})`, feedAnswers, [200, 200, 200, 200]);
  is("the file answered and kept keeps the times and names nobody", [feedShown.includes("BEGIN:VEVENT"), feedShown.includes(shyCaller), feedShown.includes(bold), feedKept.includes(shyCaller), feedKept.includes(bold), feedKept.includes("BEGIN:VEVENT")], [true, false, false, false, false, true]);
  is("each booker is shown as a buyer, never as one whose details were deleted", [feedShown.includes("A buyer"), feedShown.includes("whose details were deleted")], [true, false]);
  redis.run(["DEL", lockKey]);
  done();
}

void main();
