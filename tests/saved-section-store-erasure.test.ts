/**
 * #5010 row 126 (Codex X4-20261119-1750, MEDIUM): a saved section is kept only while its store is live. The section's
 * write (SAVE_STORE_SECTION) reads the store's fence in the same step as the write, by the rule of store-cache-live:v3
 * (lib/live-fence.ts): the store's erasing field must be absent, and its id key must still hold this store's ref (or,
 * for a store from before ids, its record must still carry the same statsId). A save that waited while the store was
 * erased, started erasing or was moved writes nothing, so the erased store's nl:sblocks: library is never made again.
 * Capacity and the section's identity are still checked in that same step, and the shared SAVE_SECTION used by other
 * bounded hashes (lib/sales-filters.ts) is unchanged.
 *
 * Synthetic store and the in-memory Redis; nothing real is called.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { ERASING_KEY, erasingField, storeIdCommand, storeRef } from "@/lib/store";
import { SAVE_SECTION, SAVE_STORE_SECTION, SAVE_STORE_SECTION_COMMANDS, writeSection } from "@/lib/saved-block-store";
import { newBlockId } from "@/lib/sales-page";
import { newSectionId, type SavedSection } from "@/lib/saved-blocks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const OWNER = "saved-section-fence@example.test";
const library = (statsId: string) => `nl:sblocks:${statsId}`;
const section = (name: string): SavedSection => ({ id: newSectionId(), name, updatedAt: 1_800_000_000, blocks: [{ id: newBlockId(), kind: "faq", heading: "Questions", items: [{ q: "Refunds?", a: "Thirty days." }] }] });

async function fixture(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "sectionfence", "Section Fence", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

const held = async (statsId: string) => ((await redis.pipeline([["HLEN", library(statsId)]])) as number[])[0];
const exists = async (key: string) => ((await redis.pipeline([["EXISTS", key]])) as number[])[0];

/** Runs `write` with the store erased (or marked) between the route's checks and the section's write, as a paused request. */
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

async function main(): Promise<void> {
  part("Control: a live store keeps its section, new and edited");
  const live = await fixture();
  const first = section("Guarantee");
  is("a new section is kept", await writeSection(live, first, true, 5), "ok");
  is("an edit of it is kept", await writeSection(live, { ...first, name: "Guarantee (edited)" }, false, 5), "ok");
  is("the library holds it", await held(live.statsId!), 1);

  part("The store erased while the save waited: nothing is written, the library is not made again");
  const erased = await fixture();
  const sid = erased.statsId!;
  const gone = await withPause(async () => {
    // The erasure's own steps, as closeStoreRecord leaves them: the id key and the library gone.
    await redis.pipeline([["DEL", storeIdCommand(erased.sid)[1]], ["DEL", library(sid)]]);
  }, () => writeSection(erased, section("Testimonials"), true, 5));
  is("RED: the save is not called kept", gone === "ok", false);
  is("RED: the erased store's library is not recreated", await exists(library(sid)), 0);

  part("The store marked erasing while the save waited: nothing is written, new or edit");
  const erasing = await fixture();
  const kept = section("Contacts");
  is("setup: a section kept while live", await writeSection(erasing, kept, true, 5), "ok");
  const mark = async () => redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(erasing)), String(Date.now())]]);
  const newOne = await withPause(mark, () => writeSection(erasing, section("Private notes"), true, 5));
  is("RED: a new section is refused", newOne === "ok", false);
  const edit = await withPause(async () => undefined, () => writeSection(erasing, { ...kept, name: "Contacts (edited)" }, false, 5));
  is("RED: an edit is refused too", edit === "ok", false);
  const raw = ((await redis.pipeline([["HGET", library(erasing.statsId!), kept.id]])) as (string | null)[])[0];
  is("the section stays as it was before the erasure began", raw === null ? null : (JSON.parse(raw) as SavedSection).name, "Contacts");
  is("and nothing new was added", await held(erasing.statsId!), 1);

  part("The store moved to another account (its id key repointed): the old store's save writes nothing");
  const moved = await fixture();
  const movedRun = await withPause(async () => {
    await redis.pipeline([["SET", storeIdCommand(moved.sid)[1], "someone-else@example.test"]]);
  }, () => writeSection(moved, section("Old store"), true, 5));
  is("RED: the save is not called kept", movedRun === "ok", false);
  is("RED: nothing was written for the old store", await held(moved.statsId!), 0);

  part("Capacity and identity are still checked in the same step");
  const full = await fixture();
  is("setup: one section", await writeSection(full, section("One"), true, 1), "ok");
  is("a second is refused at the limit", await writeSection(full, section("Two"), true, 1), "full");
  is("an edit of a section that is not there is gone", await writeSection(full, section("Missing"), false, 1), "gone");

  part("Cost: one EVAL, at most SAVE_STORE_SECTION_COMMANDS billed, and SAVE_SECTION is unchanged for its other users");
  is("SAVE_SECTION is still the shared v1 script", SAVE_SECTION.startsWith("-- marktmorgen:saved-section:v1\n"), true);
  is("the fenced script reads the erasing field and the live key before writing", SAVE_STORE_SECTION.includes("HGET") && SAVE_STORE_SECTION.includes('redis.call("GET", KEYS[2])'), true);
  const calls = (SAVE_STORE_SECTION.match(/redis\.call\(/g) ?? []).length;
  is(`one EVAL and its written calls (${calls}) are SAVE_STORE_SECTION_COMMANDS (${SAVE_STORE_SECTION_COMMANDS})`, 1 + calls, SAVE_STORE_SECTION_COMMANDS);
  const cost = await fixture();
  const real = redis.pipeline.bind(redis);
  const sent: Commands = [];
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  const costRun = await writeSection(cost, section("Cost"), true, 5);
  redis.pipeline = real;
  is("a save sends one EVAL", [costRun, sent.filter((c) => c[0] === "EVAL").length], ["ok", 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
