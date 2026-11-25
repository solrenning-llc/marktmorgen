/**
 * A product's note after paying is kept only while its store is live (Codex X4-20261119-1743, #5010 row 134): the
 * studio's save takes the note's room, then writes it; a store whose erasure began meanwhile used to get the note
 * written back with a plain SET after the erasure's walk. The write now goes through the store's fence in one step
 * (lib/live-fence.ts, keepIfStoreLive), so an erasing store gets nothing written and the save throws, and a live
 * store's note is kept as before. Real code over the memory Redis stub; synthetic data only.
 */
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { KEEP_IF_STORE_LIVE, STORE_KEEP_LIVE_COMMANDS } from "@/lib/live-fence";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOTE = { heading: "Start here", body: "A fictional welcome for a fictional buyer.", video: null, button: null };
const OWNER = "thanks-note-erasure@example.test";
const PRODUCT = "p_fictional_note";

async function liveStore() {
  redis.clear();
  if (!(await claimHandle(OWNER, "thanksnoteerase", "Fictional notes", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  if (!store.statsId) throw new Error("no statsId");
  return store;
}
const noteKey = (statsId: string) => `nl:product:note:${statsId}:${PRODUCT}`;

async function main(): Promise<void> {
  part("A live store's note is kept, in one fenced step");
  {
    const store = await liveStore();
    const sent: (string | number)[][] = [];
    const original = redis.pipeline;
    redis.pipeline = async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return original.call(redis, commands);
    };
    try {
      await writeThanksNote(store.statsId!, PRODUCT, NOTE, store);
    } finally {
      redis.pipeline = original;
    }
    is("the note reads back whole", (await readThanksNote(store.statsId, PRODUCT))?.heading, "Start here");
    const writes = sent.filter((c) => c[0] === "SET" && c[1] === noteKey(store.statsId!));
    const fenced = sent.filter((c) => c[0] === "EVAL" && c[1] === KEEP_IF_STORE_LIVE && c[5] === noteKey(store.statsId!));
    is("written by the fence's script, never by a plain SET", [fenced.length, writes.length], [1, 0]);
    is("billed as the EVAL and its HGET, GET and SET", STORE_KEEP_LIVE_COMMANDS, 4);
  }

  part("A store erasing while the note is saved gets nothing written back (Codex X4-20261119-1743)");
  {
    const store = await liveStore();
    const field = await erasingField(storeRef(store));
    // The store's erasure begins after the studio read the store and before the note is written.
    redis.run(["HSET", ERASING_KEY, field, String(Date.now())]);
    let error: unknown = null;
    try {
      await writeThanksNote(store.statsId!, PRODUCT, NOTE, store);
    } catch (caught) {
      error = caught;
    }
    is("the save throws, so the studio never says saved", error instanceof UnknownReplyError, true);
    is("and no note is kept under the erased store", Number(redis.run(["EXISTS", noteKey(store.statsId!)])), 0);
    redis.run(["HDEL", ERASING_KEY, field]);
    await writeThanksNote(store.statsId!, PRODUCT, NOTE, store);
    is("control: the same save once the mark is gone is kept", Number(redis.run(["EXISTS", noteKey(store.statsId!)])), 1);
  }

  part("A store whose record is gone gets nothing written back");
  {
    const store = await liveStore();
    // The id key is what the fence reads for a store with an id; its removal is the end of the erasure's walk.
    const idKey = `nl:store:id:${store.sid}`;
    const removed = Number(redis.run(["DEL", idKey]));
    let error: unknown = null;
    try {
      await writeThanksNote(store.statsId!, PRODUCT, NOTE, store);
    } catch (caught) {
      error = caught;
    }
    is("the id key was there to remove (the case is real)", removed, 1);
    is("the save throws and keeps nothing", [error instanceof UnknownReplyError, Number(redis.run(["EXISTS", noteKey(store.statsId!)]))], [true, 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
