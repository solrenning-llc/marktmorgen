/**
 * A store's kept reading of its sales (lib/store-readings.ts) names its
 * biggest buyers by their address. A person's erasure, by the real door
 * (lib/person-erasure.ts, erasePerson), takes that copy with it: nothing kept
 * names them afterwards (inbox C4-48, the Codex E review of #2111). The next
 * reading is made again from the store's account, which leaves them out.
 *
 * What fails here: the copy still holding the address after the erasure, or
 * the erasure not listing the readings among what it forgot.
 */
import { normaliseEmail } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { erasePerson } from "@/lib/person-erasure";
import { keptReading } from "@/lib/store-readings";
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

  part("The person's erasure, by the real door");
  const erased = await erasePerson(store, person, { kind: "person" });
  is("the erasure ends", erased.ok, true);
  is("nothing kept of the store's readings names them", String(redis.run(["GET", key]) ?? "").includes(person), false);
  is("the readings are among what it forgot", erased.ok ? erased.parts.some((p) => p.module === "lib/store-readings.ts") : false, true);
  done();
}

void main();
