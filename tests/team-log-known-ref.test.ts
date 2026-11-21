/**
 * Claude 7 on #4988: a caller that already holds the store's ref (studioAccess, storeRef(access.store)) passes it to
 * logTeam, which then sends the fenced EVAL without the GET before it, one round trip instead of two. The ref passed
 * is never permission on its own: the script compares it with the store's id key before it writes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { logTeam } from "@/lib/team";
import { claimHandle, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";

async function shop() {
  redis.clear();
  const owner = "known-ref-owner@example.test";
  assert.equal((await claimHandle(owner, "known-ref-shop", "Synthetic shop", "")).ok, true);
  return (await storeForEmail(owner))!;
}

async function trips(run: () => Promise<boolean>) {
  const base = redis.pipeline.bind(redis);
  const sent: string[] = [];
  redis.pipeline = (async (commands) => { sent.push(String(commands[0]?.[0])); return base(commands); }) as typeof redis.pipeline;
  try { return { ok: await run(), sent }; } finally { redis.pipeline = base; }
}

test("a known ref writes the line in one round trip, the fenced EVAL", async () => {
  const s = await shop();
  const out = await trips(() => logTeam(s.sid, { who: "mate@example.test", role: "editor", what: "Products: product (save)" }, storeRef(s)));
  assert.equal(out.ok, true);
  assert.deepEqual(out.sent, ["EVAL"]);
  const [rows] = await redis.pipeline([["LRANGE", `nl:team:log:${s.sid}`, 0, -1]]);
  assert.equal((rows as unknown[]).length, 1);
});

test("without a ref the GET comes first, as before", async () => {
  const s = await shop();
  const out = await trips(() => logTeam(s.sid, { who: "mate@example.test", role: "editor", what: "Products: product (save)" }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.sent, ["GET", "EVAL"]);
});

test("a stale or wrong ref passed in writes nothing: the script compares it with the store's id", async () => {
  const s = await shop();
  await redis.pipeline([["SET", storeIdCommand(s.sid)[1], "someone-else@example.test"]]);
  const out = await trips(() => logTeam(s.sid, { who: "mate@example.test", role: "editor", what: "Products: product (save)" }, storeRef(s)));
  assert.equal(out.ok, false);
  const [rows] = await redis.pipeline([["LRANGE", `nl:team:log:${s.sid}`, 0, -1]]);
  assert.deepEqual(rows, []);
});

test("an erased store's id key gone: a ref passed in still writes nothing", async () => {
  const s = await shop();
  await redis.pipeline([["DEL", storeIdCommand(s.sid)[1]]]);
  const out = await trips(() => logTeam(s.sid, { who: "mate@example.test", role: "editor", what: "Products: product (save)" }, storeRef(s)));
  assert.equal(out.ok, false);
  const [rows] = await redis.pipeline([["LRANGE", `nl:team:log:${s.sid}`, 0, -1]]);
  assert.deepEqual(rows, []);
});
