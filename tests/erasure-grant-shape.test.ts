/** Unknown grant evidence cannot delete the retained grant or certify completion. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { confirmErasure, readErasureLink } from "@/lib/erasure-request";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

test("every unknown grant shape remains pending without rewriting its retained evidence", async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  const owner = "grant-shape-owner@example.test";
  const email = "grant-shape-person@example.test";
  const token = "f".repeat(64);
  const key = "nl:erase:link:" + createHash("sha256").update("nimbus-erase-link:" + token).digest("hex").slice(0, 40);
  await claimHandle(owner, "grantshape", "Grant Shape", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  const store = (await storeForEmail(owner))!;
  const grant = JSON.stringify({ e: email, s: [store.sid] });
  const scopes: unknown[] = [[], [null], [store.sid, null], [store.sid, store.sid], ["bad"], Array(201).fill(store.sid)];
  const badRaw: unknown[] = [undefined, 0, false, {}, "", "{", "null", "[]", ...scopes.map(s => JSON.stringify({ e: email, s }))];
  const variants = [
    ...badRaw.map(raw => ({ name: `raw ${JSON.stringify(raw)}`, preview: [raw], confirm: [raw, 3600] })),
    { name: "empty envelope", preview: [], confirm: [] },
    { name: "extra response", preview: [grant, null], confirm: [grant, 3600, null] },
    { name: "missing TTL", preview: [undefined], confirm: [grant] },
    ...[undefined, null, "3600", -1, 0, NaN, Infinity, 1.5].map(ttl => ({ name: `TTL ${String(ttl)}`, preview: [undefined], confirm: [grant, ttl] })),
  ];
  for (const variant of variants) {
    await original([["SET", key, grant, "EX", 3600]]);
    const mutations: unknown[] = [];
    redis.pipeline = async commands => {
      if (commands.some(c => c[1] === key && ["SET", "DEL"].includes(String(c[0])))) mutations.push(commands);
      if (commands[0]?.[0] === "GET" && commands[0]?.[1] === key) return commands.length === 1 ? variant.preview : variant.confirm;
      return original(commands);
    };
    try {
      await assert.rejects(readErasureLink(token), variant.name + " cannot appear expired or have a partial scope");
      const result = await confirmErasure(token);
      assert.equal(result.state, "more", variant.name + " is not confirmed done or gone");
      assert.deepEqual(result.deleted, []);
      assert.equal(redis.run(["GET", key]), grant);
      assert.deepEqual(mutations, [], variant.name + " cannot consume or rewrite the grant");
    } finally { redis.pipeline = original; }
  }
  assert.deepEqual((await readErasureLink(token))?.stores.map(s => s.sid), [store.sid]);
  redis.run(["DEL", key]);
  assert.equal(await readErasureLink(token), null, "confirmed absent grant remains expired");
  assert.equal((await confirmErasure(token)).state, "gone");
});
