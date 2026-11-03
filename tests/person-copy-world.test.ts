/**
 * 619 [SZ3]: the copy of a person's data in a store where they are in every
 * module the erasure reaches (tests/erasure-world.ts): before the erasure
 * every reader finds them; after the real erasure (the person's own door)
 * only what the erasure keeps on purpose is left. Their words and other
 * people's stay apart: another person's address is never in their copy.
 */
import { normaliseEmail } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { erasePerson, erasureScope } from "@/lib/person-erasure";
import { COPY_PLAN, copyPerson } from "@/lib/person-copy";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const world = await makeWorld("copy-world");
  const person = normaliseEmail("tess.trent@example.com");
  const other = normaliseEmail("olly.other@example.com");
  await seedPerson(world, other, null);
  await seedPerson(world, person, other);
  const store = (await storeForEmail(OWNER))!;

  part("Before the erasure");
  const copy = await copyPerson((await erasureScope(store, person))!);
  const found = new Set(copy.sections.map((s) => s.module));
  const copied = Object.entries(COPY_PLAN).filter(([, p]) => p.how === "copied").map(([m]) => m);
  console.log(`  (copied modules with nothing for them: ${copied.filter((m) => !found.has(m)).join(", ") || "none"})`);
  is("every module that keeps something about them is in their copy", copied.filter((m) => !found.has(m)), EXPECTED_EMPTY);
  const text = JSON.stringify(copy);
  is("the other person's address is not in it", text.includes(other), false);
  is("the store's owner's is not either", text.includes(OWNER), false);
  const community = copy.sections.find((s) => s.module === "lib/community-erasure.ts")?.records[0] as { room: { text: string }[]; events: { event: string }[] } | undefined;
  is("what they said in the community's room, and the event they are coming to", [community?.room.map((m) => m.text), community?.events.map((e) => e.event)], [["hello room"], ["ev0001"]]);

  part("After the erasure");
  const erased = await erasePerson(store, person, { kind: "person" });
  is("erased", erased.ok, true);
  const after = await copyPerson((await erasureScope((await storeForEmail(OWNER))!, person))!);
  is("nothing the erasure reaches is left to copy", after.sections.map((s) => s.module), []);
  done();
}

/** Modules seedPerson writes nothing to for a person (see the log line above). */
const EXPECTED_EMPTY: string[] = ["lib/agreement-store.ts", "lib/affiliate-leads.ts", "lib/assistant-reminder.ts"];

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
