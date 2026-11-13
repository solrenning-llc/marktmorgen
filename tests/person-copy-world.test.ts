/**
 * 619 [SZ3]: the copy of a person's data in a store where they are in every
 * module the erasure reaches (tests/erasure-world.ts): before the erasure
 * every reader finds them; after the real erasure (the person's own door)
 * only what the erasure keeps on purpose is left. Their words and other
 * people's stay apart: another person's address is never in their copy.
 */
import { normaliseEmail } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { ERASERS, erasePerson, erasureScope } from "@/lib/person-erasure";
import { COPY_PLAN, copyPerson } from "@/lib/person-copy";
import { CURRENT_SHIPMENT_MAIL_LIFECYCLE } from "@/lib/shipment-mail-outbox";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// The store's Stripe account answers that the person paid nothing there: the world's records are all kept here.
process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_world_only";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld("copy-world");
  const person = normaliseEmail("tess.trent@example.com");
  const other = normaliseEmail("olly.other@example.com");
  await seedPerson(world, other, null);
  await seedPerson(world, person, other);
  const store = (await storeForEmail(OWNER))!;

  part("Before the erasure");
  // This world exercises production readers. Protected mail has never been
  // activated, so it must hold nothing here. Activation requires seeding and
  // copying real pending rows in this world, not extending an allowlist.
  is("the protected-mail fixture exclusion requires never activated", CURRENT_SHIPMENT_MAIL_LIFECYCLE, "never_activated");
  const mailKeys = () => [...redis.keys()].filter(key => key.startsWith("nl:ship:mail:") || key.startsWith("nl:order-confirmation:"));
  is("the world has no protected-mail records to omit", mailKeys(), []);
  const copy = await copyPerson((await erasureScope(store, person))!);
  const found = new Set(copy.sections.map((s) => s.module));
  const copied = Object.entries(COPY_PLAN).filter(([, p]) => p.how === "copied").map(([m]) => m);
  console.log(`  (copied modules with nothing for them: ${copied.filter((m) => !found.has(m)).join(", ") || "none"})`);
  is("every module that keeps something about them is in their copy", copied.filter((m) => !found.has(m)), EXPECTED_EMPTY);
  is("inactive mail readers created no records", mailKeys(), []);
  const text = JSON.stringify(copy);
  is("the other person's address is not in it", text.includes(other), false);
  is("the store's owner's is not either", text.includes(OWNER), false);
  const community = copy.sections.find((s) => s.module === "lib/community-erasure.ts")?.records[0] as { room: { text: string }[]; events: { event: string }[]; privateMessages: { request: boolean; messages: { from: string; text: string }[] }[] } | undefined;
  is("what they said in the community's room, and the event they are coming to", [community?.room.map((m) => m.text), community?.events.map((e) => e.event)], [["hello room"], ["ev0001"]]);
  is("their private conversation, whole", community?.privateMessages.map((c) => c.messages.map((m) => [m.from, m.text])), [[["you", "hi"]]]);

  part("After the erasure");
  const erased = await erasePerson(store, person, { kind: "person" });
  is("erased", erased.ok, true);
  const after = await copyPerson((await erasureScope((await storeForEmail(OWNER))!, person))!);
  // What the erasure keeps on purpose (lib/person-data.ts, "kept") may stay; what it reaches may not.
  const reached = new Set(ERASERS.map((e) => e.module));
  is("nothing the erasure reaches is left to copy", after.sections.map((s) => s.module).filter((m) => reached.has(m)), []);
  done();
}

/** Modules seedPerson writes nothing to for a person (see the log line above). */
const EXPECTED_EMPTY: string[] = ["lib/shipment-mail-outbox.ts", "lib/order-confirmation-outbox.ts", "lib/agreement-store.ts", "lib/affiliate-leads.ts", "lib/assistant-reminder.ts", "lib/paypal-sales.ts", "lib/licence-keys.ts", "lib/gifts.ts", "lib/group-buy.ts", "lib/preorders.ts", "lib/call-packages.ts", "lib/meet-records.ts", "lib/shipments.ts", "lib/closing-buyers.ts", "lib/closing-holds.ts"];
// 761 [STN8]: nothing calls the made-to-order record yet, so the world keeps none.
EXPECTED_EMPTY.push("lib/made-to-order.ts");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
