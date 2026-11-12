import { DraftReadUnavailable, DraftRemovalUnconfirmed, removeDraft, saveDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  redis.clear();
  const store = { listId: "draft-versions", catalog: { items: [] } } as unknown as Store;
  const input = { subject: "Original", body: "Original", productId: "" };
  const first = await saveDraft(store, "owner@example.com", input);
  if (!first.ok) throw new Error("fixture failed");
  const id = first.draft.id;
  const key = "nl:mail:drafts:" + store.listId;
  const lock = key + ":lock:" + id;
  const original = redis.pipeline;
  /** A draft's save or delete: a plain HSET/HDEL, or (under the lease, since #3343's follow-up) one script naming the drafts hash. */
  const writesDraft = (c: (string | number)[], kind: "set" | "del" | "any") =>
    (c[1] === key && (kind === "any" ? c[0] === "HSET" || c[0] === "HDEL" : c[0] === (kind === "set" ? "HSET" : "HDEL")))
    || (c[0] === "EVAL" && c.includes(key) && (kind === "any" ? /^-- marktmorgen:draft-(set|del)-held:/ : new RegExp("^-- marktmorgen:draft-" + kind + "-held:")).test(String(c[1])));
  const read = async () => JSON.parse(String((await original.call(redis, [["HGET", key, id]]))[0]));
  part("An older session cannot overwrite a newer saved version");
  const newer = await saveDraft(store, "other@example.com", { ...input, id, body: "Other team member", expectedSavedAt: first.draft.savedAt });
  is("matching version is saved", newer.ok, true);
  if (!newer.ok) throw new Error("fixture update failed");
  is("every update has a strictly newer version", Date.parse(newer.draft.savedAt) > Date.parse(first.draft.savedAt), true);
  is("stale editor is refused", await saveDraft(store, "owner@example.com", { ...input, id, body: "Stale text", expectedSavedAt: first.draft.savedAt }), { ok: false, reason: "draft_conflict" });
  is("other team member's text survives", (await read()).body, "Other team member");
  for (const expectedSavedAt of [null, "", "invalid", 1, []]) {
    is("invalid expected version cannot overwrite", await saveDraft(store, "owner@example.com", { ...input, id, expectedSavedAt }), { ok: false, reason: "draft_conflict" });
  }
  const clock = Date.now;
  Date.now = () => Date.parse(first.draft.savedAt);
  try {
    const next = await saveDraft(store, "owner@example.com", { ...input, id, expectedSavedAt: newer.draft.savedAt });
    is("clock granularity cannot reuse a version", next.ok && Date.parse(next.draft.savedAt) > Date.parse(newer.draft.savedAt), true);
  } finally { Date.now = clock; }
  part("Save and delete share one draft lease");
  let release!: () => void, entered!: () => void;
  let pauseGet = true;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const current = await read();
  redis.pipeline = async commands => {
    if (pauseGet && commands.some(c => c[0] === "HGET" && c[1] === key)) { entered(); await blocked; }
    return original.call(redis, commands);
  };
  const pendingSave = saveDraft(store, "owner@example.com", { ...input, id, body: "First writer", expectedSavedAt: current.savedAt });
  await reached;
  // The first holder's own lease value (lib/claim-mark.ts claimValue), not a fixed constant.
  const holder = (await original.call(redis, [["GET", lock]]))[0];
  is("second writer is refused while the first holds the draft", await saveDraft(store, "other@example.com", { ...input, id, expectedSavedAt: current.savedAt }), { ok: false, reason: "draft_busy" });
  let deleteBlocked = false;
  try { await removeDraft(store, id); } catch (e) { deleteBlocked = e instanceof DraftRemovalUnconfirmed; }
  is("delete cannot enter during a save", deleteBlocked, true);
  is("refused operations retain the first holder's lease", typeof holder === "string" && (await original.call(redis, [["GET", lock]]))[0] === holder, true);
  pauseGet = false; release();
  is("first writer completes", (await pendingSave).ok, true);
  redis.pipeline = original;
  is("first writer's body survives", (await read()).body, "First writer");
  is("the excluded writer remains stale after the lock releases", await saveDraft(store, "other@example.com", { ...input, id, expectedSavedAt: current.savedAt }), { ok: false, reason: "draft_conflict" });
  let finishDelete!: () => void, deletionStarted!: () => void;
  const deleting = new Promise<void>(resolve => { finishDelete = resolve; });
  const deletionReached = new Promise<void>(resolve => { deletionStarted = resolve; });
  redis.pipeline = async commands => {
    if (commands.some(c => writesDraft(c, "del"))) { deletionStarted(); await deleting; }
    return original.call(redis, commands);
  };
  const pendingDelete = removeDraft(store, id);
  await deletionReached;
  is("writer cannot enter during delete", await saveDraft(store, "owner@example.com", { ...input, id }), { ok: false, reason: "draft_busy" });
  finishDelete();
  is("delete completes", await pendingDelete, true);
  redis.pipeline = original;
  is("save cannot recreate a deleted draft", await saveDraft(store, "owner@example.com", { ...input, id, expectedSavedAt: current.savedAt }), { ok: false, reason: "unknown" });
  await original.call(redis, [["HSET", key, id, JSON.stringify(current)]]);
  part("Unknown lease acknowledgements never authorize mutation");
  let writes = 0;
  for (const reply of [[], [undefined], [true], [1], ["ok"], ["OK", null], new Error("lock response lost")]) {
    redis.pipeline = async commands => {
      writes += commands.filter(c => writesDraft(c, "any")).length;
      if (commands.some(c => c[0] === "SET" && c[1] === lock)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return original.call(redis, commands);
    };
    let saveBlocked = false, removalBlocked = false;
    try { await saveDraft(store, "owner@example.com", { ...input, id }); } catch (e) { saveBlocked = e instanceof DraftReadUnavailable; }
    try { await removeDraft(store, id); } catch (e) { removalBlocked = e instanceof DraftRemovalUnconfirmed; }
    is("save refuses an unconfirmed lease", saveBlocked, true);
    is("delete refuses an unconfirmed lease", removalBlocked, true);
  }
  is("no writes without a confirmed lease", writes, 0);
  redis.pipeline = original;
  is("legacy clients can still update under the lease", (await saveDraft(store, "owner@example.com", { ...input, id })).ok, true);
  is("normal validation refusal releases its lease", (await saveDraft(store, "owner@example.com", { ...input, id, subject: "" })).ok, false);
  is("lease was released", (await original.call(redis, [["GET", lock]]))[0], null);
  done();
}
void main();
