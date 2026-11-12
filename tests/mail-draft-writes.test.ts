import { DraftRemovalUnconfirmed, removeDraft, DraftReadUnavailable, DraftWriteUnconfirmed, saveDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const listId = "draft-write-tests";
const key = "nl:mail:drafts:" + listId;
const store = { listId, catalog: { items: [] } } as unknown as Store;
const first = { id: "1111111111111111", subject: "First", body: "Original", productId: null, by: "owner@example.com", savedAt: "2026-10-15T00:00:00.000Z" };
const second = { ...first, id: "2222222222222222", subject: "Second" };
async function main() {
  part("Draft write acknowledgement");
  const original = redis.pipeline;
  const normal = Symbol("normal");
  let reply: unknown = normal;
  let applyWrite = false;
  let readReply: unknown = normal;
  let writes = 0;
  let deleteReply: unknown = normal;
  let applyDelete = false;
  // A draft's save and delete: a plain HSET (a new draft) or, under the lease since #3343's follow-up, one script naming the hash.
  const held = (command: (string | number)[], kind: "set" | "del") => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:draft-" + kind + "-held:") && command.includes(key);
  const sets = (command: (string | number)[]) => (command[0] === "HSET" && command[1] === key) || held(command, "set");
  const deletes = (command: (string | number)[]) => (command[0] === "HDEL" && command[1] === key) || held(command, "del");
  redis.pipeline = async commands => {
    if (commands.some(deletes) && deleteReply !== normal) {
      if (applyDelete) await original.call(redis, commands);
      if (deleteReply instanceof Error) throw deleteReply;
      return deleteReply as unknown[];
    }
    writes += commands.filter(sets).length;
    if (commands.some(command => (command[0] === "HLEN" || command[0] === "HEXISTS") && command[1] === key) && readReply !== normal) {
      if (readReply instanceof Error) throw readReply;
      return readReply as unknown[];
    }
    if (commands.some(sets) && reply !== normal) {
      if (applyWrite) await original.call(redis, commands);
      if (reply instanceof Error) throw reply;
      return reply as unknown[];
    }
    return original.call(redis, commands);
  };
  const input = { subject: "Updated", body: "Updated content", productId: "" };
  try {
    await original.call(redis, [["DEL", key], ["HSET", key, first.id, JSON.stringify(first), second.id, JSON.stringify(second)]]);
    const snapshot = (await original.call(redis, [["HGETALL", key]]))[0];
    for (const invalid of [[], null, {}, [null], [true], ["1"], [-1], [1.2], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [0, 1], new Error("read unavailable")]) {
      readReply = invalid;
      for (const id of [undefined, first.id]) {
        writes = 0;
        let rejected = false;
        try { await saveDraft(store, "owner@example.com", { ...input, id }); } catch (error) { rejected = error instanceof DraftReadUnavailable; }
        is("unknown preflight refuses save " + String(invalid) + " " + String(id), rejected, true);
        is("unknown preflight makes no write", writes, 0);
        is("unknown preflight preserves stored drafts", (await original.call(redis, [["HGETALL", key]]))[0], snapshot);
      }
    }
    readReply = [2];
    writes = 0;
    let invalidExists = false;
    try { await saveDraft(store, "owner@example.com", { ...input, id: first.id }); } catch (error) { invalidExists = error instanceof DraftReadUnavailable; }
    is("exists only accepts zero or one", invalidExists, true);
    is("invalid exists makes no write", writes, 0);
    readReply = [20];
    is("confirmed full collection refuses creation", await saveDraft(store, "owner@example.com", input), { ok: false, reason: "full" });
    is("full collection makes no write", writes, 0);
    readReply = [0];
    is("confirmed absent draft refuses editing", await saveDraft(store, "owner@example.com", { ...input, id: first.id }), { ok: false, reason: "unknown" });
    is("absent draft makes no write", writes, 0);
    readReply = normal;
    for (const uncertain of [[], [null], [true], ["1"], [-1], [2], [1, 0], null, {}, new Error("write unavailable")]) {
      reply = uncertain;
      for (const id of [undefined, first.id]) {
        // An edit's script answers -1 only when its lease ran out and nothing was written: refused as busy, never saved.
        if (id && JSON.stringify(uncertain) === "[-1]") {
          is("an edit whose lease ran out is refused, never saved", await saveDraft(store, "owner@example.com", { ...input, id }), { ok: false, reason: "draft_busy" });
          continue;
        }
        let rejected = false;
        try { await saveDraft(store, "owner@example.com", { ...input, id }); } catch (error) { rejected = error instanceof DraftWriteUnconfirmed; }
        is("unconfirmed " + (id ? "edit" : "creation") + " " + String(uncertain), rejected, true);
      }
    }
    is("failed writes preserve original", (await original.call(redis, [["HGET", key, first.id]]))[0], JSON.stringify(first));
    is("failed writes preserve another draft", (await original.call(redis, [["HGET", key, second.id]]))[0], JSON.stringify(second));
    applyWrite = true;
    reply = [];
    let unconfirmed = false;
    try { await saveDraft(store, "owner@example.com", { ...input, id: first.id }); } catch (error) { unconfirmed = error instanceof DraftWriteUnconfirmed; }
    is("applied write with lost acknowledgement stays unconfirmed", unconfirmed, true);
    is("unconfirmed does not mean rollback", JSON.parse(String((await original.call(redis, [["HGET", key, first.id]]))[0])).body, input.body);
    reply = [0];
    is("confirmed overwrite acknowledgement is valid", (await saveDraft(store, "owner@example.com", { ...input, id: first.id })).ok, true);
    applyWrite = false;
    reply = normal;
    is("confirmed new-field acknowledgement is valid", (await saveDraft(store, "owner@example.com", input)).ok, true);
    is("creation keeps other drafts", (await original.call(redis, [["HLEN", key]]))[0], 3);
    is("successful writes preserve unrelated draft", (await original.call(redis, [["HGET", key, second.id]]))[0], JSON.stringify(second));
    await original.call(redis, [["DEL", key]]);
    readReply = [0];
    is("confirmed zero permits creation", (await saveDraft(store, "owner@example.com", input)).ok, true);
    is("zero count creation writes one draft", (await original.call(redis, [["HLEN", key]]))[0], 1);
    await original.call(redis, [["DEL", key], ["HSET", key, first.id, JSON.stringify(first), second.id, JSON.stringify(second)]]);
    for (const invalid of [[], [null], [true], ["1"], [-1], [2], [1, 0], null, {}, new Error("delete unavailable")]) {
      deleteReply = invalid;
      let unconfirmed = false;
      try { await removeDraft(store, first.id); } catch (error) { unconfirmed = error instanceof DraftRemovalUnconfirmed; }
      is("removal needs numeric acknowledgement " + String(invalid), unconfirmed, true);
    }
    is("unapplied failed removals preserve target", (await original.call(redis, [["HGET", key, first.id]]))[0], JSON.stringify(first));
    applyDelete = true;
    deleteReply = [];
    let removalUnconfirmed = false;
    try { await removeDraft(store, first.id); } catch (error) { removalUnconfirmed = error instanceof DraftRemovalUnconfirmed; }
    is("applied removal with lost acknowledgement stays unconfirmed", removalUnconfirmed, true);
    is("lost removal acknowledgement does not restore target", (await original.call(redis, [["HGET", key, first.id]]))[0], null);
    applyDelete = false;
    deleteReply = normal;
    is("confirmed absent target returns false", await removeDraft(store, first.id), false);
    await original.call(redis, [["HSET", key, first.id, JSON.stringify(first)]]);
    is("confirmed removal succeeds", await removeDraft(store, first.id), true);
    is("removal preserves unrelated draft", (await original.call(redis, [["HGET", key, second.id]]))[0], JSON.stringify(second));
  } finally { redis.pipeline = original; }
  done();
}
void main();
