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
import { bookedCalendar, bookedCalendarFeed, ensureFeedToken, withoutErasedBookers } from "@/lib/calendar-sync";
import { readFileSync } from "node:fs";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_readings_erasure_only";
/** The checkouts the stand-in for Stripe lists (the races below); none otherwise. */
let checkouts: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const listing = String(input).includes("/checkout/sessions?") && (init?.method ?? "GET") === "GET";
  return new Response(JSON.stringify({ object: "list", data: listing ? checkouts : [], has_more: false }), { status: 200 });
}) as typeof fetch;

/**
 * `work`, with the person's erasure (the real door) run whole right after the
 * first look among the store's deleted people (the HMGET of nl:erased) and
 * before anything else the work sends: the race of a reading begun before the
 * erasure and kept after it (review of #2111).
 */
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
  is("the studio's sales reading goes through it", readFileSync("lib/store-readings.ts", "utf8").includes("return withoutErasedBuyers(store, await readSales(store, now));"), true);
  const calls = [
    { session: "cs_1", start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, product: "p1", email: person, name: "Rhea Reader", moves: 0 },
    { session: "cs_2", start: Date.now() + 2 * 86_400_000, end: Date.now() + 2 * 86_400_000 + 3_600_000, product: "p1", email: other, name: "Otto Other", moves: 0 },
  ];
  const unnamed = await withoutErasedBookers(store, calls);
  const ics = bookedCalendar(store, unnamed, Date.now(), []);
  is("the calendar file made again keeps the booked time but does not name them", [ics.includes(person), ics.includes("Rhea"), ics.includes("A buyer whose details were deleted"), ics.includes(other)], [false, false, true, true]);
  is("the feed's route goes through it", readFileSync("app/api/store/calendar/[token]/route.ts", "utf8").includes("await withoutErasedBookers(store, await paidCalls(store))"), true);

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
  redis.run(["DEL", `nl:cal:pace:${store.statsId}`]);
  const again = await bookedCalendarFeed(owner, making, Date.now() + 1);
  is("the next making leaves them unnamed and is kept", [again.state, JSON.stringify(again).includes(booker), String(redis.run(["GET", feedKey]) ?? "").includes(guest), String(redis.run(["GET", feedKey]) ?? "").includes(booker)], ["made", false, true, false]);
  done();
}

void main();
