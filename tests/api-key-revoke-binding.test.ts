/**
 * #2899 open findings on f7906fcbe7, with the actual helpers and route; only Redis replies are synthetic:
 * - MEDIUM (Codex G): a record of key A carrying key B's hash must never delete B's global lookup.
 * - LEVE (Claude 7): a key already gone (another tab revoked it) is "already gone", never "unconfirmed".
 * - LOW (Claude 1): a deletion that may have applied but whose answer was lost (transport error)
 *   is "unconfirmed", never "Nothing was changed".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { POST } from "@/app/api/store/api-keys/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

const original = redis.pipeline.bind(redis);
const origin = "https://marktmorgen.com";

async function studio(handle: string) {
  redis.clear();
  const owner = `${handle}@example.test`;
  await claimHandle(owner, handle, "Synthetic revoke", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const session = await openSession(owner);
  const revoke = (id: string) => POST(new NextRequest(`${origin}/api/store/api-keys?store=${store.sid}`, {
    method: "POST", headers: { "content-type": "application/json", origin, host: "marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "revoke", id }),
  }));
  return { store, revoke };
}

test("a record of key A carrying key B's hash never takes B's access away", async () => {
  const sid = "c".repeat(32);
  redis.clear();
  const a = await makeKey(sid, "Key A");
  const b = await makeKey(sid, "Key B");
  if (!a.ok || !b.ok) throw new Error("Synthetic setup failed");
  const listKey = `nl:api:keys:${sid}`;
  const [rawB] = await original([["HGET", listKey, b.made.id]]) as string[];
  const [rawA] = await original([["HGET", listKey, a.made.id]]) as string[];
  const hashB = (JSON.parse(rawB) as { hash: string }).hash;
  // Anomalous reply: HGET(A) answers A's record with B's hash.
  redis.pipeline = async (commands) => commands.length === 1 && commands[0]?.[0] === "HGET" && commands[0]?.[1] === listKey && commands[0]?.[2] === a.made.id
    ? [JSON.stringify({ ...JSON.parse(rawA), hash: hashB })]
    : original(commands);
  let gone: boolean;
  try { gone = await revokeKey(sid, a.made.id); } finally { redis.pipeline = original; }
  assert.equal(gone, false, "never reported revoked from a record that is not A's");
  assert.equal((await resolveKey(b.key))?.id, b.made.id, "B still opens the store");
  assert.equal((await resolveKey(a.key))?.id, a.made.id, "A was not partly revoked either");
});

test("revoking a key another tab already revoked says it is already gone", async () => {
  const { store, revoke } = await studio("qrevokegone");
  const made = await makeKey(store.sid, "Two tabs");
  if (!made.ok) throw new Error("Synthetic setup failed");
  // The list read by the route still shows the key; the other tab's revocation lands right after it.
  let raced = false;
  redis.pipeline = async (commands) => {
    if (!raced && commands.length === 1 && commands[0]?.[0] === "HGET" && String(commands[0]?.[1]).startsWith("nl:api:") && commands[0]?.[2] === made.made.id) {
      raced = true;
      redis.pipeline = original;
      assert.equal(await revokeKey(store.sid, made.made.id), true);
    }
    return original(commands);
  };
  let response: Response;
  try { response = await revoke(made.made.id); } finally { redis.pipeline = original; }
  assert.equal(raced, true);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "unknown" });
});

test("a deletion applied with its answer lost to a transport error is unconfirmed, never 'nothing was changed'", async () => {
  const { store, revoke } = await studio("qrevokelost");
  const made = await makeKey(store.sid, "Lost answer");
  if (!made.ok) throw new Error("Synthetic setup failed");
  let applied = 0;
  redis.pipeline = async (commands) => {
    if (commands.length === 4 && commands[0]?.[0] === "DEL" && String(commands[0]?.[1]).startsWith("nl:api:k:")) {
      await original(commands);
      applied += 1;
      throw new Error("Redis request failed with status 504");
    }
    return original(commands);
  };
  let response: Response;
  try { response = await revoke(made.made.id); } finally { redis.pipeline = original; }
  assert.equal(applied, 1);
  assert.equal(await resolveKey(made.key), null, "the deletion really landed");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "revoke_unconfirmed" });
});
