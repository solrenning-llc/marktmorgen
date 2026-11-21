import { finishBroadcastDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  const store = { listId: "campaign-cleanup" } as Store;
  const key = "nl:mail:drafts:" + store.listId;
  const id = "1111111111111111";
  const original = redis.pipeline;
  const normal = Symbol("normal");
  let reply: unknown = normal;
  let apply = false;
  let attempts = 0;
  /** The draft's delete: since #3343's follow-up, one script that names the drafts hash and checks the lease. */
  const deletes = (command: (string | number)[]) => (command[0] === "HDEL" && command[1] === key) || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:draft-del-held:") && command.includes(key));
  redis.pipeline = async commands => {
    if (!commands.some(deletes)) return original.call(redis, commands);
    attempts += 1;
    if (reply === normal) return original.call(redis, commands);
    if (apply) await original.call(redis, commands);
    if (reply instanceof Error) throw reply;
    return reply as unknown[];
  };
  try {
    part("No draft and invalid references");
    is("no draft needs no cleanup", await finishBroadcastDraft(store, ""), true);
    is("invalid id cannot confirm cleanup", await finishBroadcastDraft(store, "invalid"), false);
    is("missing list cannot confirm cleanup", await finishBroadcastDraft({ ...store, listId: null }, id), false);
    is("no storage operations for these cases", attempts, 0);
    part("Confirmed absence and removal");
    is("already absent draft is confirmed", await finishBroadcastDraft(store, id), true);
    await original.call(redis, [["HSET", key, id, "saved text"]]);
    is("existing draft is removed", await finishBroadcastDraft(store, id), true);
    is("removed draft is absent", (await original.call(redis, [["HEXISTS", key, id]]))[0], 0);
    part("Cleanup failure must not escape after campaign creation");
    for (const invalid of [null, {}, [], [null], [true], ["1"], [-1], [2], [0, 1], new Error("lost response")]) {
      reply = invalid; apply = false; attempts = 0;
      await original.call(redis, [["HSET", key, id, "saved text"]]);
      is("uncertain cleanup returns false without throwing", await finishBroadcastDraft(store, id), false);
      is("cleanup is attempted only once", attempts, 1);
      is("draft remains when delete did not run", (await original.call(redis, [["HEXISTS", key, id]]))[0], 1);
    }
    apply = true; reply = new Error("applied but response lost"); attempts = 0;
    is("applied deletion with lost response remains unconfirmed", await finishBroadcastDraft(store, id), false);
    is("no retry or recreation after lost response", attempts, 1);
    is("applied deletion remains applied", (await original.call(redis, [["HEXISTS", key, id]]))[0], 0);
    reply = normal;
    is("later confirmed absence is safe", await finishBroadcastDraft(store, id), true);
  } finally { redis.pipeline = original; }
  done();
}
void main();
