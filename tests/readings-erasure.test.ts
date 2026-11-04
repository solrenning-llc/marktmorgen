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
import { storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { keptReading, withoutErasedBuyers } from "@/lib/store-readings";
import { bookedCalendar, withoutErasedBookers } from "@/lib/calendar-sync";
import { readFileSync } from "node:fs";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_readings_erasure_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

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
  done();
}

void main();
