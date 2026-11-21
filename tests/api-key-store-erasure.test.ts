/**
 * A key creation admitted before the store's erasure must not restore its credential records or the
 * creator-typed name afterwards (Codex L-20261120-0937): the real owner route and the real revoker,
 * synthetic data and the in-memory Redis only. On main the late SET/HSET recreate both and the
 * route answers 200 with the new secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/api-keys/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeKey, revokeAllKeys } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, ensureStoreId, ERASING_KEY, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const OWNER = "keys-erasure@example.test";
const MARKER = "-- marktmorgen:api-key-create-live:v1\n";
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
async function world() {
  redis.clear();
  assert.equal((await claimHandle(OWNER, "keys-erasure", "Synthetic", "")).ok, true);
  await ensureStoreId(OWNER); await ensureStatsId(OWNER);
  const shop = await storeForEmail(OWNER); assert.ok(shop);
  const session = await openSession(OWNER);
  const seeded = await makeKey(shop.sid, "existing synthetic key"); assert.equal(seeded.ok, true);
  return { shop, session, list: `nl:api:keys:${shop.sid}` };
}
function call(session: string, sid: string) {
  return POST(new NextRequest(`https://marktmorgen.com/api/store/api-keys?store=${sid}`, {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" },
    body: JSON.stringify({ action: "make", name: "synthetic-person@example.test", write: false }),
  }));
}
function creation(commands: Commands, list: string) {
  const script = commands.find((c) => c[0] === "EVAL" && String(c[1]).startsWith(MARKER) && c[5] === list);
  if (script) return String(script[6]);
  const lookup = commands.find((c) => c[0] === "SET" && String(c[1]).startsWith("nl:api:k:"));
  return commands.some((c) => c[0] === "HSET" && c[1] === list) && lookup ? String(lookup[1]) : null;
}
test("key creation cannot restore erased store credentials or personal names", { timeout: 10000 }, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no provider calls in this synthetic test"); };
  try {
    for (const phase of ["erasing", "gone"] as const) {
      await t.test(phase, async () => {
        const w = await world(), started = gate(), release = gate();
        let pendingLookup = "";
        redis.pipeline = async (commands: Commands) => {
          const target = creation(commands, w.list);
          if (target && !pendingLookup) { pendingLookup = target; started.open(); await release.wait; }
          return real(commands);
        };
        const running = call(w.session, w.shop.sid);
        try {
          await started.wait;
          const ref = storeRef(w.shop), field = await erasingField(ref);
          await real([["HSET", ERASING_KEY, field, String(Date.now())]]);
          // The production revoker, after it has read and removed the pre-existing key.
          assert.equal(await revokeAllKeys(w.shop.sid), 1);
          if (phase === "gone") {
            await real([["DEL", storeIdCommand(w.shop.sid)[1], await ownerKey(ref)], ["HDEL", ERASING_KEY, field]]);
          }
          release.open();
          const response = await running, body = await response.json();
          assert.equal(response.status, 503);
          assert.equal(body.ok, false);
          assert.equal(body.key, undefined);
          assert.equal((await real([["GET", pendingLookup]]))[0], null);
          assert.equal((await real([["HLEN", w.list]]))[0], 0);
        } finally { release.open(); await running.catch(() => {}); redis.pipeline = real; }
      });
    }
    await t.test("healthy control keeps both records", async () => {
      const w = await world();
      let cost = 0;
      redis.pipeline = async (commands: Commands) => {
        const before = redis.scriptCalls;
        const out = await real(commands);
        if (commands.length === 1 && commands[0][0] === "HLEN" && commands[0][1] === w.list) cost++;
        if (creation(commands, w.list)) cost += commands.length + redis.scriptCalls - before;
        return out;
      };
      let response: Response;
      try { response = await call(w.session, w.shop.sid); } finally { redis.pipeline = real; }
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(cost, 7);
      assert.equal(body.ok, true);
      assert.match(body.key, /^nl_live_[0-9a-f]{40}$/);
      assert.equal((await real([["HLEN", w.list]]))[0], 2);
    });
    await t.test("unknown final write reply rolls back its new records", async () => {
      const w = await world();
      let lookup = "", scripts = 0;
      redis.pipeline = async (commands: Commands) => {
        const target = creation(commands, w.list);
        if (target) {
          lookup = target;
          const out = await real(commands);
          if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(MARKER))) { scripts++; return []; }
          return out; // Old main remains a real success: this RED cannot pass by a missing new export.
        }
        return real(commands);
      };
      try {
        const response = await call(w.session, w.shop.sid), body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.key, undefined);
        assert.equal(scripts, 1);
        assert.equal((await real([["GET", lookup]]))[0], null);
        assert.equal((await real([["HLEN", w.list]]))[0], 1);
      } finally { redis.pipeline = real; }
    });
  } finally { redis.pipeline = real; globalThis.fetch = originalFetch; }
});

