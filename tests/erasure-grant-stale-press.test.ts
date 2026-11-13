/**
 * A press of an erasure link that read the grant, and wrote what was left of it back after another press finished
 * the same link, revived a used link, up to 60 s past its expiry (#4281, Codex L, transcribed by Claude 1).
 *
 * What is checked:
 *   - press A reads the grant, leaves its stores for later; press B runs to the end and deletes the link in between;
 *     A's write-back then finds the grant changed: the link stays used (nothing written back), and A does not say "more";
 *   - a single press that leaves stores for later keeps exactly them, under the grant's own expiry, never extended to 60 s.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { confirmErasure, readErasureLink } from "@/lib/erasure-request";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const PERSON = "stale-press-person@example.test";
const keyOf = (token: string) => "nl:erase:link:" + createHash("sha256").update("nimbus-erase-link:" + token).digest("hex").slice(0, 40);
/** A press whose clock is already past the press's 40 s: every store is left for later, nothing erased. */
const late = () => Date.now() - 41_000;

async function storeNamed(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example.test`;
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  return (await storeForEmail(owner))!;
}

/** Whether a command writes the link's key: a plain SET or DEL, or a script naming it as its first key. */
const writes = (key: string) => (c: (string | number)[]) =>
  (["SET", "DEL"].includes(String(c[0]).toUpperCase()) && c[1] === key) || (String(c[0]).toUpperCase() === "EVAL" && c[3] === key);

test("a press that finds its grant changed writes nothing back and does not revive the link", async () => {
  redis.clear();
  const x = await storeNamed("staleprx");
  const y = await storeNamed("staleprey");
  const token = "a".repeat(64);
  const key = keyOf(token);
  const grant = JSON.stringify({ e: PERSON, s: [x.sid, y.sid] });
  redis.run(["SET", key, grant, "EX", 3600]);
  const original = redis.pipeline.bind(redis);
  let other: Awaited<ReturnType<typeof confirmErasure>> | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!other && commands.some(writes(key))) {
      // Press B, in another tab, runs to the end before press A's write lands.
      redis.pipeline = original;
      other = await confirmErasure(token);
      redis.pipeline = hook;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const hook = redis.pipeline;
  let first;
  try {
    first = await confirmErasure(token, late());
  } finally {
    redis.pipeline = original;
  }
  assert.ok(other, "press B ran in between");
  assert.equal((other as { state: string }).state, "done", "press B finished the link");
  assert.equal(redis.run(["GET", key]), null, "the used link is not written back");
  assert.equal(await readErasureLink(token), null, "the used link opens nothing");
  assert.notEqual(first.state, "more", "press A does not say there is more for stores press B finished");
});

test("a single press keeps exactly the stores left, under the grant's own expiry", async () => {
  redis.clear();
  const x = await storeNamed("stalesolox");
  const y = await storeNamed("stalesoloy");
  const token = "b".repeat(64);
  const key = keyOf(token);
  redis.run(["SET", key, JSON.stringify({ e: PERSON, s: [x.sid, y.sid] }), "EX", 30]);
  const result = await confirmErasure(token, late());
  assert.equal(result.state, "more");
  assert.deepEqual(result.later, [x.sid, y.sid]);
  assert.deepEqual((JSON.parse(String(redis.run(["GET", key]))) as { s: string[] }).s, [x.sid, y.sid]);
  const ttl = Number(redis.run(["TTL", key]));
  assert.ok(ttl > 0 && ttl <= 30, `the expiry is the grant's own (30 s), never extended: ${ttl}`);
});
