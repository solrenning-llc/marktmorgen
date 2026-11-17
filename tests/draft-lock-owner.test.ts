/**
 * Rule 24 (r24 unit 6.1): a draft's save/delete lease is let go only while it
 * still holds this run's own value. A slow save or delete whose 90-second lease
 * ran out, and was taken by another tab, must never delete that other tab's
 * lease; otherwise a third operation could enter and overwrite or delete the
 * draft during the other tab's version check.
 */
import { DraftReadUnavailable, DraftRemovalUnconfirmed, removeDraft, saveDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];

async function main() {
  redis.clear();
  const store = { listId: "lock-owner", catalog: { items: [] } } as unknown as Store;
  const input = { subject: "Original", body: "Original", productId: "" };
  const first = await saveDraft(store, "owner@example.com", input);
  if (!first.ok) throw new Error("fixture failed");
  const id = first.draft.id;
  const key = "nl:mail:drafts:" + store.listId;
  const lock = key + ":lock:" + id;
  const original = redis.pipeline;
  const raw = (commands: Commands) => original.call(redis, commands);

  /** After our lease is taken, it runs out and another tab takes it, before our operation ends. */
  async function withLeaseTakenOver<T>(run: () => Promise<T>): Promise<T> {
    let taken = false, swapped = false;
    redis.pipeline = (async (commands: Commands) => {
      if (taken && !swapped) {
        swapped = true;
        await raw([["SET", lock, "another-tab", "EX", 90]]);
      }
      const answer = await raw(commands);
      if (commands[0]?.[0] === "SET" && commands[0]?.[1] === lock) taken = true;
      return answer;
    }) as typeof redis.pipeline;
    try { return await run(); } finally { redis.pipeline = original; }
  }

  part("A healthy save and delete let go of their own lease");
  const saved = await saveDraft(store, "owner@example.com", { ...input, id, body: "Second", expectedSavedAt: first.draft.savedAt });
  is("save under the lease succeeds", saved.ok, true);
  if (!saved.ok) throw new Error("fixture update failed");
  is("the lease is gone after a save", (await raw([["EXISTS", lock]]))[0], 0);

  part("The lease holds a value no other run writes");
  let held: unknown = null;
  redis.pipeline = (async (commands: Commands) => {
    const answer = await raw(commands);
    if (commands.some(c => c[0] === "HGET" && c[1] === key)) held = (await raw([["GET", lock]]))[0];
    return answer;
  }) as typeof redis.pipeline;
  let current = saved.draft;
  try {
    const next = await saveDraft(store, "owner@example.com", { ...input, id, body: "Third", expectedSavedAt: current.savedAt });
    if (!next.ok) throw new Error("fixture update failed");
    current = next.draft;
  } finally { redis.pipeline = original; }
  is("the lease value is not a fixed constant", typeof held === "string" && held !== "1" && held.length > 1, true);

  part("A slow save whose lease ran out never deletes the other tab's lease");
  const late = await withLeaseTakenOver(() => saveDraft(store, "owner@example.com", { ...input, id, body: "Late", expectedSavedAt: current.savedAt }));
  // Since #3343's follow-up the write itself checks the lease: the late save is refused, never saved (Claude 2 on #3343).
  is("the late save is refused, never saved", late, { ok: false, reason: "draft_busy" });
  is("and the stored draft is not the late one", JSON.parse(String((await raw([["HGET", key, id]]))[0])).body, "Third");
  is("the other tab's lease stays", (await raw([["GET", lock]]))[0], "another-tab");
  is("so a third save is still kept out", await saveDraft(store, "third@example.com", { ...input, id, body: "Third tab", expectedSavedAt: current.savedAt }), { ok: false, reason: "draft_busy" });
  await raw([["DEL", lock]]);

  part("A slow delete whose lease ran out never deletes the other tab's lease");
  const lateDelete = await withLeaseTakenOver(() => removeDraft(store, id, current.savedAt).then(() => "deleted", (error: unknown) => error instanceof DraftRemovalUnconfirmed ? "unconfirmed" : "other"));
  is("the late delete deletes nothing and is not confirmed", lateDelete, "unconfirmed");
  is("and the draft is still there", (await raw([["HEXISTS", key, id]]))[0], 1);
  is("the other tab's lease stays after a delete", (await raw([["GET", lock]]))[0], "another-tab");
  await raw([["DEL", lock]]);

  part("A taken lease is busy; an unreadable claim is unknown, never ours");
  const again = await saveDraft(store, "owner@example.com", { ...input, body: "Fresh" });
  if (!again.ok) throw new Error("fixture save failed");
  const otherLock = key + ":lock:" + again.draft.id;
  await raw([["SET", otherLock, "another-tab", "EX", 90]]);
  is("a lease another tab holds is busy", await saveDraft(store, "owner@example.com", { ...input, id: again.draft.id, body: "x", expectedSavedAt: again.draft.savedAt }), { ok: false, reason: "draft_busy" });
  is("and it is not deleted", (await raw([["GET", otherLock]]))[0], "another-tab");
  await raw([["DEL", otherLock]]);
  for (const reply of [["QUEUED"], [], [1]]) {
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SET" && commands[0]?.[1] === otherLock) return reply;
      return raw(commands);
    }) as typeof redis.pipeline;
    let unknown = false;
    try { await saveDraft(store, "owner@example.com", { ...input, id: again.draft.id, body: "y", expectedSavedAt: again.draft.savedAt }); }
    catch (error) { unknown = error instanceof DraftReadUnavailable; }
    finally { redis.pipeline = original; }
    is(`a lease claim answered ${JSON.stringify(reply)} and not written is unknown`, unknown, true);
  }
  done();
}
void main();
