/**
 * #5285 row #5277 (Claude 1's note 7092560877 on #5277): a store's saved sales filters (nl:sales:filters:<statsId>,
 * lib/sales-filters.ts) were written with the unfenced SAVE_SECTION, so a save or a rename that waited while the
 * store was erased, started erasing or was moved wrote the hash back after the erasure's walk. The write now goes
 * through SAVE_STORE_SECTION (lib/saved-block-store.ts), the same fence #5010 row 126 put on the saved sections: the
 * store's erasing field must be absent and its id key must still hold this store's ref (or, for a store from before
 * ids, its record must still carry the same statsId), in the same step as the write. Capacity and the filter's
 * identity are still checked in that step.
 *
 * Synthetic store and the in-memory Redis; nothing real is called.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { ERASING_KEY, erasingField, storeIdCommand, storeRef } from "@/lib/store";
import { MAX_SAVED_FILTERS, filterFromQuery } from "@/lib/sales-filter-rules";
import { readSavedFilters, renameSalesFilter, saveSalesFilter } from "@/lib/sales-filters";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const OWNER = "filters-fence@example.test";
const hash = (statsId: string) => `nl:sales:filters:${statsId}`;
const courses = () => filterFromQuery("product=Course&kind=products");

async function fixture(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "filtersfence", "Filters Fence", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

const exists = async (key: string) => ((await redis.pipeline([["EXISTS", key]])) as number[])[0];
const held = async (statsId: string) => ((await redis.pipeline([["HLEN", hash(statsId)]])) as number[])[0];

/** Runs `write` with `before` done between the route's reads and the filter's write, as a paused request. */
async function withPause<T>(before: () => Promise<unknown>, write: () => Promise<T>): Promise<T | Error> {
  const real = redis.pipeline.bind(redis);
  let fired = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!fired && commands.some((c) => c[0] === "EVAL" && /-- marktmorgen:saved(-store)?-section:/.test(String(c[1])))) {
      fired = true;
      redis.pipeline = real;
      await before();
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await write();
  } catch (error) {
    return error as Error;
  } finally {
    redis.pipeline = real;
  }
}

const kept = (result: unknown) => typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
/** The answer's refusal, so a store erased meanwhile is told "gone" (the route's 404), never "full" (Claude 1's NIT 1 on #5329, 7098033249). */
const reason = (result: unknown) => (typeof result === "object" && result !== null ? (result as { reason?: unknown }).reason : undefined);

async function main(): Promise<void> {
  part("Control: a live store keeps a new filter and a rename");
  const live = await fixture();
  const first = await saveSalesFilter(live, "Courses", courses());
  is("a new filter is kept", kept(first), true);
  const id = kept(first) ? (first as { filter: { id: string } }).filter.id : "";
  is("a rename is kept", kept(await renameSalesFilter(live, id, "All courses")), true);
  is("the list holds it, renamed", (await readSavedFilters(live.statsId!)).map((f) => f.name), ["All courses"]);

  part("The store erased while the save waited: nothing is written, the hash is not made again");
  const erased = await fixture();
  const sid = erased.statsId!;
  const gone = await withPause(async () => {
    // The erasure's own steps, as closeStoreRecord leaves them: the id key and the filters gone.
    await redis.pipeline([["DEL", storeIdCommand(erased.sid)[1]], ["DEL", hash(sid)]]);
  }, () => saveSalesFilter(erased, "Courses", courses(), []));
  is("RED: the save is not called kept", kept(gone), false);
  is("the save is refused as gone, not as full", reason(gone), "gone");
  is("RED: the erased store's filters are not recreated", await exists(hash(sid)), 0);

  part("The store marked erasing while the save waited: nothing is written, new or rename");
  const erasing = await fixture();
  const before = await saveSalesFilter(erasing, "Courses", courses());
  is("setup: a filter kept while live", kept(before), true);
  const keptId = kept(before) ? (before as { filter: { id: string } }).filter.id : "";
  const mark = async () => redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(erasing)), String(Date.now())]]);
  const newOne = await withPause(mark, () => saveSalesFilter(erasing, "Refunds", filterFromQuery("product=Refund&kind=products")));
  is("RED: a new filter is refused", kept(newOne), false);
  is("the new filter is refused as gone, not as full", reason(newOne), "gone");
  const renamed = await withPause(async () => undefined, () => renameSalesFilter(erasing, keptId, "Renamed"));
  is("RED: a rename is refused too", kept(renamed), false);
  is("the rename is refused as gone", reason(renamed), "gone");
  const raw = ((await redis.pipeline([["HGET", hash(erasing.statsId!), keptId]])) as (string | null)[])[0];
  is("the filter stays as it was before the erasure began", raw === null ? null : (JSON.parse(raw) as { name: string }).name, "Courses");
  is("and nothing new was added", await held(erasing.statsId!), 1);

  part("The store moved to another account (its id key repointed): the old store's save writes nothing");
  const moved = await fixture();
  const movedRun = await withPause(async () => {
    await redis.pipeline([["SET", storeIdCommand(moved.sid)[1], "someone-else@example.test"]]);
  }, () => saveSalesFilter(moved, "Courses", courses(), []));
  is("RED: the save is not called kept", kept(movedRun), false);
  is("the moved store's save is refused as gone, not as full", reason(movedRun), "gone");
  is("RED: nothing was written for the old store", await held(moved.statsId!), 0);

  part("Capacity is still checked in the same step");
  const full = await fixture();
  for (let i = 0; i < MAX_SAVED_FILTERS; i++) await saveSalesFilter(full, `Filter ${i}`, filterFromQuery(`product=P${i}&kind=products`));
  is("setup: the store holds MAX_SAVED_FILTERS", await held(full.statsId!), MAX_SAVED_FILTERS);
  const past = await saveSalesFilter(full, "One more", filterFromQuery("product=More&kind=products"), []);
  is("one more is refused as full, even when the list read before looked empty", [kept(past), (past as { reason?: string }).reason], [false, "full"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
