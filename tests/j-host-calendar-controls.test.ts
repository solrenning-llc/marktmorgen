import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { hostSync, prefetchHosts } from "@/lib/host-calendar";
import { store as redis } from "./redis-stub";
const pipeline = redis.pipeline;
const fetchBefore = globalThis.fetch;
const shop = { statsId: "j-calendar-control" };
const email = "host@example.com";
const now = 1_800_000_000_000;
const cfg = JSON.stringify({ email, source: "ics", read: [], write: "", ics: "sealed", icsAddedAt: "2026-11-05" });
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = fetchBefore; });
for (const mode of ["accessor", "inherited"] as const) {
  test(`${mode} configuration slots cannot manufacture a free host`, async () => {
    redis.clear(); let getters = 0, calls = 0;
    const raw = [cfg, null, null];
    if (mode === "accessor") Object.defineProperty(raw, "0", { get() { getters++; return null; }, enumerable: true });
    else { delete raw[0]; Object.setPrototypeOf(raw, Object.assign(Object.create(Array.prototype), { 0: null })); }
    redis.pipeline = async () => { calls++; return [raw]; };
    globalThis.fetch = async () => { throw Error("No provider request allowed"); };
    const result = await hostSync(shop, email, "UTC", { now });
    assert.equal(result.blocked, true); assert.equal(result.state, "failed");
    assert.equal(getters, 0); assert.equal(calls, 1);
  });
}
test("a valid cache from another source cannot establish availability", async () => {
  let calls = 0;
  redis.pipeline = async () => { calls++; throw Error("No read needed for known evidence"); };
  const good = JSON.stringify({ at: now, busy: [], source: "google" });
  const result = await hostSync(shop, email, "UTC", { now, known: { cfg, good, err: null, conn: null } });
  assert.equal(result.blocked, true); assert.equal(result.state, "failed"); assert.equal(calls, 0);
});
test("transport rejection blocks hostSync and rejects prefetch without further work", async () => {
  let calls = 0;
  redis.pipeline = async () => { calls++; throw Error("Synthetic read unavailable"); };
  const result = await hostSync(shop, email, "UTC", { now });
  assert.equal(result.blocked, true); assert.equal(result.state, "failed");
  await assert.rejects(prefetchHosts(shop, [email]), /Synthetic read unavailable/);
  assert.equal(calls, 2);
});
