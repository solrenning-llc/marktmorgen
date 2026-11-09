/**
 * Rule 24 (Claude 2 on #3343): a draft is written or deleted only while the
 * save's own lease still holds its value, checked in the same step as the
 * write. Two tabs edit one draft: tab A takes the lease and reads v1, its
 * lease runs out before its write lands, and tab B takes the lease and saves
 * v2. Tab A's write must then be refused, never reported as saved, and v2
 * must stay. The same for a delete. An answer of another shape is never a
 * save or a delete: it stays unconfirmed.
 */
import { DraftRemovalUnconfirmed, DraftWriteUnconfirmed, removeDraft, saveDraft, type Draft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];

async function main() {
  redis.clear();
  const store = { listId: "lock-token-write", catalog: { items: [] } } as unknown as Store;
  const key = "nl:mail:drafts:" + store.listId;
  const input = { subject: "Draft", body: "v1", productId: "" };
  const original = redis.pipeline;
  const raw = (commands: Commands) => original.call(redis, commands);
  const stored = async (id: string): Promise<Draft | null> => {
    const value = (await raw([["HGET", key, id]]))[0];
    return typeof value === "string" ? JSON.parse(value) as Draft : null;
  };
  let tick = Date.parse("2026-11-01T00:00:00.000Z");
  /** Puts a known version of the draft in place, so each part starts from it whatever the part before did. */
  const seed = async (id: string, body: string): Promise<Draft> => {
    const draft: Draft = { id, subject: "Draft", body, productId: null, by: "a@example.com", savedAt: new Date(tick += 1000).toISOString() };
    await raw([["HSET", key, id, JSON.stringify(draft)]]);
    return draft;
  };
  /** The command that changes a draft field: a plain HSET/HDEL, or a script that names the drafts hash. */
  const writes = (command: (string | number)[]) =>
    ((command[0] === "HSET" || command[0] === "HDEL") && command[1] === key) || (command[0] === "EVAL" && command.includes(key));

  /** Just before this run's own write lands, its lease runs out and `meanwhile` runs whole, as another tab. */
  async function stalledBeforeWrite<T>(run: () => Promise<T>, meanwhile: () => Promise<unknown>): Promise<T> {
    let armed = true;
    redis.pipeline = (async (commands: Commands) => {
      if (armed && commands.some(writes)) {
        armed = false;
        redis.pipeline = original;
        redis.advance(91_000);
        await meanwhile();
        redis.pipeline = original;
      }
      return raw(commands);
    }) as typeof redis.pipeline;
    try { return await run(); } finally { redis.pipeline = original; }
  }

  part("Control: a save and a delete that keep their lease work as before");
  const made = await saveDraft(store, "a@example.com", input);
  if (!made.ok) throw new Error("fixture failed");
  const id = made.draft.id;
  const v1 = await saveDraft(store, "a@example.com", { ...input, id, body: "v1 edited", expectedSavedAt: made.draft.savedAt });
  is("a healthy edit is saved", v1.ok, true);
  if (!v1.ok) throw new Error("fixture failed");
  is("its text is stored", (await stored(id))?.body, "v1 edited");

  part("Tab A's lease ran out and tab B saved v2: A's late save is refused and v2 stays");
  let b: Awaited<ReturnType<typeof saveDraft>> | null = null;
  const late = await stalledBeforeWrite(
    () => saveDraft(store, "a@example.com", { ...input, id, body: "Tab A stale", expectedSavedAt: v1.draft.savedAt }),
    async () => { b = await saveDraft(store, "b@example.com", { ...input, id, body: "Tab B v2", expectedSavedAt: v1.draft.savedAt }); },
  );
  is("tab B's save is saved", (b as { ok: boolean } | null)?.ok, true);
  is("stale holder A's save is refused", late, { ok: false, reason: "draft_busy" });
  is("tab B's newer work survives", (await stored(id))?.body, "Tab B v2");

  part("A's lease ran out and nobody took it: the late save is still refused");
  const v2 = await seed(id, "Tab B v2");
  const lapsed = await stalledBeforeWrite(
    () => saveDraft(store, "a@example.com", { ...input, id, body: "Lapsed", expectedSavedAt: v2.savedAt }),
    async () => {},
  );
  is("a save whose lease ran out is refused", lapsed, { ok: false, reason: "draft_busy" });
  is("the stored draft is unchanged", (await stored(id))?.body, "Tab B v2");

  part("Tab A's delete lease ran out and tab B saved v3: A's late delete deletes nothing");
  const before = await seed(id, "Tab B v2");
  let v3: Draft | null = null;
  let deleteError: unknown = null;
  await stalledBeforeWrite(
    () => removeDraft(store, id, before.savedAt).catch((error: unknown) => { deleteError = error; return null; }),
    async () => { const saved = await saveDraft(store, "b@example.com", { ...input, id, body: "Tab B v3", expectedSavedAt: before.savedAt }); if (saved.ok) v3 = saved.draft; },
  );
  is("tab B's save during the stall is saved", (v3 as Draft | null)?.body, "Tab B v3");
  is("the late delete is not confirmed", deleteError instanceof DraftRemovalUnconfirmed, true);
  is("tab B's draft is still there", (await stored(id))?.body, "Tab B v3");
  deleteError = null;
  await seed(id, "Tab B v3");
  await stalledBeforeWrite(() => removeDraft(store, id).catch((error: unknown) => { deleteError = error; return null; }), async () => {});
  is("a delete whose lease ran out, with no version, deletes nothing", deleteError instanceof DraftRemovalUnconfirmed, true);
  is("and the draft is still there", (await stored(id))?.body, "Tab B v3");

  part("A write answered in another shape is never saved or deleted");
  const current = await seed(id, "Tab B v3");
  for (const reply of [[], [null], [true], ["1"], [2], [-2], [1, 0], null, {}, new Error("lost")]) {
    redis.pipeline = (async (commands: Commands) => {
      if (commands.some(writes)) { if (reply instanceof Error) throw reply; return reply; }
      return raw(commands);
    }) as typeof redis.pipeline;
    let saveUnconfirmed = false, deleteUnconfirmed = false;
    try { await saveDraft(store, "a@example.com", { ...input, id, body: "unknown", expectedSavedAt: current.savedAt }); } catch (error) { saveUnconfirmed = error instanceof DraftWriteUnconfirmed; }
    try { await removeDraft(store, id, current.savedAt); } catch (error) { deleteUnconfirmed = error instanceof DraftRemovalUnconfirmed; }
    redis.pipeline = original;
    is(`a save answered ${JSON.stringify(reply instanceof Error ? "error" : reply)} is unconfirmed`, saveUnconfirmed, true);
    is(`a delete answered ${JSON.stringify(reply instanceof Error ? "error" : reply)} is unconfirmed`, deleteUnconfirmed, true);
  }
  is("the draft is untouched by unknown answers", (await stored(id))?.body, "Tab B v3");

  part("Control: a delete that keeps its lease deletes");
  const last = await seed(id, "Tab B v3");
  is("a healthy delete deletes", await removeDraft(store, id, last.savedAt), true);
  is("the draft is gone", await stored(id), null);
  is("a confirmed absent draft is not deleted again", await removeDraft(store, id), false);
  done();
}
void main();
