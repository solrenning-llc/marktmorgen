import { DraftRemovalConflict, DraftRemovalUnconfirmed, finishBroadcastDraft, removeDraft, saveDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const store = { listId: "delete-versions", catalog: { items: [] } } as unknown as Store;
  const input = { subject: "Original", body: "Original", productId: "" };
  const first = await saveDraft(store, "owner@example.com", input);
  if (!first.ok) throw new Error("fixture failed");
  const newer = await saveDraft(store, "other@example.com", { ...input, id: first.draft.id, body: "Newer work", expectedSavedAt: first.draft.savedAt });
  if (!newer.ok) throw new Error("fixture update failed");
  const draft = newer.draft, id = draft.id;
  const key = "nl:mail:drafts:" + store.listId;
  const original = redis.pipeline;
  /** The draft's delete: since #3343's follow-up, one script that names the drafts hash and checks the lease. */
  const deletes = (c: (string | number)[]) => (c[0] === "HDEL" && c[1] === key) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:draft-del-held:") && c.includes(key));
  const seed = async () => original.call(redis, [["HSET", key, id, JSON.stringify(draft)]]);
  const read = async () => (await original.call(redis, [["HGET", key, id]]))[0];
  part("An old screen cannot delete newer work");
  let conflict = false;
  try { await removeDraft(store, id, first.draft.savedAt); } catch (e) { conflict = e instanceof DraftRemovalConflict; }
  is("stale deletion is a known conflict", conflict, true);
  is("newer work remains intact", await read(), JSON.stringify(draft));
  is("campaign cleanup cannot remove a newer draft", await finishBroadcastDraft(store, id, first.draft.savedAt), false);
  is("cleanup conflict preserves the newer draft", await read(), JSON.stringify(draft));
  is("matching version can be deleted", await removeDraft(store, id, draft.savedAt), true);
  is("confirmed absence is not a new deletion", await removeDraft(store, id, draft.savedAt), false);
  is("confirmed absence completes campaign cleanup", await finishBroadcastDraft(store, id, draft.savedAt), true);
  part("Invalid versions do not authorize deletion");
  await seed();
  for (const expected of [null, "", "invalid", 1, {}]) {
    conflict = false;
    try { await removeDraft(store, id, expected); } catch (e) { conflict = e instanceof DraftRemovalConflict; }
    is("invalid expected version is refused", conflict, true);
    is("invalid expected version preserves the record", await read(), JSON.stringify(draft));
  }
  part("Unknown stored versions are not guessed");
  let deletions = 0;
  for (const reply of [[], [undefined], ["broken"], ["null"], [JSON.stringify({ ...draft, id: "2222222222222222" })], [JSON.stringify({ ...draft, savedAt: "invalid" })], new Error("read lost")]) {
    redis.pipeline = async commands => {
      deletions += commands.filter(deletes).length;
      if (commands.some(c => c[0] === "HGET" && c[1] === key)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return original.call(redis, commands);
    };
    let unknown = false;
    try { await removeDraft(store, id, draft.savedAt); } catch (e) { unknown = e instanceof DraftRemovalUnconfirmed; }
    is("unreadable version stays unconfirmed", unknown, true);
    is("no deletion after failed version read", deletions, 0);
    is("stored record stays intact", await read(), JSON.stringify(draft));
  }
  redis.pipeline = original;
  part("The version read stays protected until deletion");
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "HGET" && c[1] === key)) { entered(); await blocked; }
    return original.call(redis, commands);
  };
  const removing = removeDraft(store, id, draft.savedAt);
  await reached;
  is("save cannot race between version read and delete", await saveDraft(store, "owner@example.com", { ...input, id, expectedSavedAt: draft.savedAt }), { ok: false, reason: "draft_busy" });
  release();
  is("versioned deletion completes", await removing, true);
  redis.pipeline = original;
  is("deleted record is absent", await read(), null);
  part("A lost deletion response does not recreate the draft");
  await seed();
  redis.pipeline = async commands => {
    if (commands.some(deletes)) {
      await original.call(redis, commands);
      throw new Error("applied delete response lost");
    }
    return original.call(redis, commands);
  };
  is("campaign cleanup remains unconfirmed after lost reply", await finishBroadcastDraft(store, id, draft.savedAt), false);
  is("applied deletion is not reversed", await read(), null);
  redis.pipeline = original;
  done();
}
void main();
