/**
 * A studio reading too large to keep (READING_COPY_MAX_BYTES, lib/store-readings.ts keptReading) is never written as a
 * copy, so it never passes the check made where a copy is written (READING_COPY) against the people deleted while it
 * was being made. It is shown with its totals and naming nobody (#4758, Codex L; reproduced by Claude 2 on main
 * 8a47273d8e). Controls: a reading within the limit still names everyone not deleted; a large reading naming nobody
 * is shown as read. Every store, person and identifier here is a synthetic stand-in.
 */
import { type Store, storeForEmail } from "@/lib/store";
import { keptReading, READING_COPY_MAX_BYTES } from "@/lib/store-readings";
import { suppressCommand } from "@/lib/suppression";
import { normaliseEmail } from "@/lib/auth";
import { OWNER, makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Reading = { total: number; filler: string; names: string[] };

async function main(): Promise<void> {
  redis.clear();
  await makeWorld();
  const store = (await storeForEmail(OWNER)) as Store;
  const listId = store.listId as string;
  const erased = normaliseEmail("erased.during.read@example.com");
  const kept = normaliseEmail("still.here@example.com");
  const guard = {
    listId,
    names: (v: Reading) => v.names,
    without: (v: Reading, gone: Set<string>) => ({ ...v, names: v.names.filter((n) => !gone.has(n)) }),
  };
  const run = (filler: string, names: string[], eraseDuring: boolean) =>
    keptReading(store, "sales", async () => {
      // The person's erasure completes while the reading is being made, after it looked at the deleted people.
      if (eraseDuring) await redis.pipeline([suppressCommand(listId, erased)]);
      return { total: 1234, filler, names } as Reading;
    }, Date.now(), true, guard);
  const copy = () => redis.run(["GET", `nl:reading:sales:${store.statsId}`]);

  part("control: a reading within the copy limit, a person erased while it was made");
  const small = await run("x", [erased, kept], true);
  is("the reading shown names only the person not deleted", small?.value.names, [kept]);

  part("a reading above READING_COPY_MAX_BYTES, the same erasure while it was made");
  redis.run(["DEL", `nl:reading:sales:${store.statsId}`]);
  const big = await run("x".repeat(READING_COPY_MAX_BYTES + 1), [erased, kept], true);
  is("the reading shown does not name the erased person", big?.value.names.includes(erased), false);
  is("it names nobody, and says so", [big?.value.names, big?.unnamed], [[], true]);
  is("its totals are kept", big?.value.total, 1234);
  is("it is not kept as a copy", copy(), null);

  part("control: a large reading naming nobody is shown as read");
  // A new day's budget of readings for the store: the world made again.
  redis.clear();
  await makeWorld();
  const none = await run("x".repeat(READING_COPY_MAX_BYTES + 1), [], false);
  is("shown whole, not marked unnamed", [none?.value.total, none?.value.filler.length, none?.unnamed ?? false], [1234, READING_COPY_MAX_BYTES + 1, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
