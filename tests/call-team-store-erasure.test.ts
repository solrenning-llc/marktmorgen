/**
 * A call's host setup saved by a request admitted before the store's erasure must not be restored
 * afterwards (Codex L-20261120-1028): the real call-team POST and writer, synthetic stores and the
 * in-memory Redis, no provider calls. On main the late HSET recreates the hosts' addresses and hours.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/call-team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ERASING_KEY, erasingField, ownerKey, setProductCall, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import type { TeamSetup } from "@/lib/team-scheduling-rules";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const OWNER = "team-erasure@example.test";
const MARKER = "-- marktmorgen:team-setup-live:v1\n";
const weekly: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const setup: CallSetup = { kind: "weekly", minutes: 60, tz: "UTC", weekly, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.test/synthetic-room", video: false, meet: null, seats: 1, sessions: [] };
const team: TeamSetup = { mode: "round_robin", hosts: [{ email: OWNER, tz: "UTC", weekly, bufferMinutes: 0, noticeHours: 1, dailyCap: 4, label: "Synthetic host" }], createdAt: "2026-11-20T00:00:00.000Z" };
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
async function world() {
  redis.clear();
  assert.equal((await claimHandle(OWNER, "team-erasure", "Synthetic", "")).ok, true);
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TeamErasureFixture", subscriptionId: "sub_TeamErasureFixture", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic call", "", "120", null); assert.ok(made.ok);
  assert.equal((await setProductCall(OWNER, made.product.id, setup)).ok, true);
  const shop = await storeForEmail(OWNER); assert.ok(shop?.callsId);
  const session = await openSession(OWNER);
  return { shop, session, id: made.product.id, key: `nl:callteam:${shop.callsId}` };
}
function call(w: Awaited<ReturnType<typeof world>>) {
  return POST(new NextRequest(`https://marktmorgen.com/api/store/call-team?store=${w.shop.sid}`, {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie: `${SESSION_COOKIE}=${w.session}`, "content-type": "application/json" },
    body: JSON.stringify({ id: w.id, team }),
  }));
}
function saving(commands: Commands, key: string) {
  return commands.some((c) => (c[0] === "HSET" && c[1] === key) ||
    (c[0] === "EVAL" && String(c[1]).startsWith(MARKER) && c[5] === key));
}
test("a call's host setup cannot be restored after store erasure wins", { timeout: 10000 }, async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no provider calls in this synthetic test"); };
  try {
    for (const phase of ["erasing", "gone"] as const) {
      await t.test(phase, async () => {
        const w = await world(), started = gate(), release = gate();
        let paused = false;
        redis.pipeline = async (commands: Commands) => {
          if (!paused && saving(commands, w.key)) { paused = true; started.open(); await release.wait; }
          return real(commands);
        };
        const running = call(w);
        try {
          // The early-return check reads a clone, and only before the gate: the route's own body stays unread for below.
          let reached = false;
          await Promise.race([started.wait.then(() => { reached = true; }), running.then(async (response) => {
            if (!reached) throw new Error(`route returned before persistence gate: ${response.status} ${await response.clone().text()}`);
          })]);
          const ref = storeRef(w.shop), field = await erasingField(ref);
          await real([["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", w.key]]);
          if (phase === "gone") {
            await real([["DEL", storeIdCommand(w.shop.sid)[1], await ownerKey(ref)], ["HDEL", ERASING_KEY, field]]);
          }
          release.open();
          const response = await running, body = await response.json();
          assert.equal((await real([["HGET", w.key, w.id]]))[0], null, "no email, label or weekly hours restored");
          assert.equal(response.status, 503);
          assert.equal(body.ok, false);
          assert.equal(body.error, "unavailable");
          // Cleanup remains possible and creates no data after the identity has gone.
          await writeTeam(w.shop, w.id, null);
          assert.equal((await real([["EXISTS", w.key]]))[0], 0);
        } finally { release.open(); await running.catch(() => {}); redis.pipeline = real; }
      });
    }
    await t.test("healthy create and overwrite both confirm, at four billed commands", async () => {
      const w = await world();
      for (let i = 0; i < 2; i++) {
        let measured = 0;
        redis.pipeline = async (commands: Commands) => {
          const before = redis.scriptCalls, out = await real(commands);
          if (saving(commands, w.key)) measured += commands.length + redis.scriptCalls - before;
          return out;
        };
        let response: Response;
        try { response = await call(w); } finally { redis.pipeline = real; }
        assert.equal(response.status, 200);
        assert.equal((await response.json()).ok, true);
        const row = JSON.parse(String((await real([["HGET", w.key, w.id]]))[0]));
        assert.equal(row.hosts[0].email, OWNER);
        assert.equal(measured, 4);
      }
    });
    await t.test("an applied save with an unknown response is not reported successful or retried", async () => {
      const w = await world();
      let writes = 0;
      redis.pipeline = async (commands: Commands) => {
        if (saving(commands, w.key)) {
          writes++;
          const out = await real(commands);
          return commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(MARKER)) ? [] : out;
        }
        return real(commands);
      };
      try {
        const response = await call(w), body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.ok, false);
        assert.equal(writes, 1);
        // Unknown is not a claim that nothing was written. The applied row stays; erasure will delete it.
        assert.equal(typeof (await real([["HGET", w.key, w.id]]))[0], "string");
      } finally { redis.pipeline = real; }
    });
    await t.test("legacy no-SID stores use their canonical record and the same erasure mark", async () => {
      const w = await world(), legacy = { ...w.shop, sid: "" };
      await writeTeam(legacy, w.id, team);
      assert.equal(typeof (await real([["HGET", w.key, w.id]]))[0], "string");
      await real([["HSET", ERASING_KEY, await erasingField(storeRef(legacy)), String(Date.now())], ["DEL", w.key]]);
      await assert.rejects(writeTeam(legacy, w.id, team), /could not be saved/);
      assert.equal((await real([["HGET", w.key, w.id]]))[0], null);
      // A new store can reuse the same owner reference after completed erasure:
      // the legacy write must still match the old callsId, not merely an existing record.
      await real([["HDEL", ERASING_KEY, await erasingField(storeRef(legacy))],
        ["SET", await ownerKey(storeRef(legacy)), JSON.stringify({ ...w.shop, callsId: "different-call-id" })]]);
      await assert.rejects(writeTeam(legacy, w.id, team), /could not be saved/);
      assert.equal((await real([["HGET", w.key, w.id]]))[0], null);
    });
  } finally { redis.pipeline = real; globalThis.fetch = originalFetch; }
});

