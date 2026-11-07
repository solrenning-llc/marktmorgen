/**
 * CX-123 rule 24: a store's kept pitches are read exactly. Before, an HGETALL answered in an unknown shape (or a
 * pitch that does not read) became "no pitches": a new pitch to a business written to a few days ago passed the
 * REPITCH_DAYS wait, one marked stopped no longer stopped it, and MAX_PITCHES was not held. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { type PageReader, linkKey, listPitches, saveSender, startPitch, stopFromLink } from "@/lib/outreach";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000) - 86_400;
const pitchesKey = (statsId: string) => `nl:outreach:${statsId}:pitches`;
const pitch = (id: string, status: string) =>
  JSON.stringify({ id, domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", status, createdAt: NOW - 3 * 86_400, sentAt: NOW - 3 * 86_400 });

const fixture = (async () => {
  redis.clear();
  const made = await claimHandle("pitch-owner@example.com", "pitch-harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("pitch-owner@example.com");
  await setSubscription("pitch-owner@example.com", { customerId: "cus_Pitch000001", subscriptionId: "sub_Pitch000001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }) });
  const store = (await storeForEmail("pitch-owner@example.com"))!;
  await saveSender(store, { name: "Jenny Park", address: "PO Box 12, Columbus, OH 43004, USA" });
  redis.run(["HSET", pitchesKey(store.statsId!), "0000000000000001", pitch("0000000000000001", "sent")]);
  return store;
})();

const real = redis.pipeline.bind(redis);
type Command = (string | number)[];
function answerHgetall(reply: unknown) {
  redis.pipeline = (async (commands: Command[]) => (commands[0]?.[0] === "HGETALL" ? reply : real(commands))) as typeof redis.pipeline;
}

const UNKNOWN: [string, unknown][] = [
  ["a missing envelope", []],
  ["a null result", [null]],
  ["a number", [3]],
  ["an odd-length list", [["0000000000000001"]]],
  ["a non-string value", [["0000000000000001", 7]]],
  ["a value that is not a pitch", [["0000000000000001", "{"]]],
];

for (const [label, reply] of UNKNOWN) {
  test(`listPitches: ${label} is unknown, never "no pitches"`, async () => {
    const store = await fixture;
    answerHgetall(reply);
    try { await assert.rejects(() => listPitches(store)); }
    finally { redis.pipeline = real; }
  });

  test(`startPitch: ${label} refuses as unavailable before the business's page is read`, async () => {
    const store = await fixture;
    const read: string[] = [];
    const reader = (async (url: string) => { read.push(url); return null; }) as PageReader;
    answerHgetall(reply);
    let result: Awaited<ReturnType<typeof startPitch>>;
    try {
      result = await startPitch(store, { goal: "sponsor", country: "US", isCompany: false, page: "https://copperoak.com/partners", email: "partnerships@copperoak.com", company: "Copper & Oak", about: "Pans.", notes: "Recipes." }, { reader, now: NOW });
    } finally { redis.pipeline = real; }
    assert.deepEqual(result, { ok: false, reason: "unavailable" });
    assert.deepEqual(read, []);
  });
}

test("healthy control: a kept pitch is listed; a pitch to the same business three days ago still holds the wait", async () => {
  const store = await fixture;
  const listed = await listPitches(store);
  assert.deepEqual(listed.map((p) => [p.id, p.status]), [["0000000000000001", "sent"]]);
  const reader = (async (url: string) =>
    url === "https://copperoak.com/partners"
      ? { url, html: "<p>Creators: write to partnerships@copperoak.com</p>" }
      : null) as PageReader;
  const result = await startPitch(store, { goal: "sponsor", country: "US", isCompany: false, page: "https://copperoak.com/partners", email: "partnerships@copperoak.com", company: "Copper & Oak", about: "Pans.", notes: "Recipes." }, { reader, now: NOW });
  assert.deepEqual(result, { ok: false, reason: "recent" });
});

test("confirmed absence: a store with no kept pitch has none", async () => {
  const store = await fixture;
  assert.deepEqual(await listPitches({ ...store, statsId: "synthetic-no-pitches" }), []);
});

// Codex Q on #2870 (LOW): a kept pitch whose times do not read would count as written long ago (sentAt || createdAt
// is 0), so the wait before the same business is written to again would pass. Every writer keeps createdAt, and a
// sent or stopped pitch its sentAt; a kept pitch without them is unknown.
for (const [label, value] of [
  ["a sent pitch with null times", JSON.stringify({ id: "0000000000000001", domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", status: "sent", createdAt: null, sentAt: null })],
  ["a stopped pitch with no sentAt", JSON.stringify({ id: "0000000000000001", domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", status: "stopped", createdAt: NOW - 3 * 86_400 })],
  ["a draft with no createdAt", JSON.stringify({ id: "0000000000000001", domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", status: "draft", sentAt: 0 })],
] as [string, string][]) {
  test(`listPitches: ${label} is unknown, never written long ago`, async () => {
    const store = await fixture;
    answerHgetall([["0000000000000001", value]]);
    try { await assert.rejects(() => listPitches(store)); }
    finally { redis.pipeline = real; }
  });
}

// J and Codex Q on #2870 (MEDIUM): the stop link said "done" on a write whose answer was not known. Its receipt is
// read exactly: one count for each SADD and for the HSET; anything else throws, and the route answers done=0.
const TOKEN = "a".repeat(32);
async function seedLink(): Promise<string> {
  const store = await fixture;
  redis.run(["SET", linkKey(TOKEN), JSON.stringify({ s: store.statsId, id: "0000000000000001", d: "copperoak.com", n: "Harbor Kitchen" })]);
  redis.run(["HSET", pitchesKey(store.statsId!), "0000000000000001", pitch("0000000000000001", "sent")]);
  redis.run(["SREM", `nl:outreach:${store.statsId}:stop`, "copperoak.com"]);
  redis.run(["SREM", "nl:outreach:stop:all", "copperoak.com"]);
  return store.statsId!;
}
const isStopWrite = (commands: Command[]) => commands.some((c) => c[0] === "SADD");

for (const everyone of [false, true]) {
  const scope = everyone ? "every store" : "this store";
  for (const [label, alter] of [
    ["not applied, no replies", async () => []],
    ["applied, one reply short", async (commands: Command[]) => (await real(commands)).slice(0, -1)],
    ["applied, a reply in another shape", async (commands: Command[]) => (await real(commands)).map((r: unknown, i: number) => (i === 0 ? "OK" : r))],
  ] as [string, (commands: Command[]) => Promise<unknown[]>][]) {
    test(`stopFromLink (${scope}): ${label} is never "done"`, async () => {
      await seedLink();
      redis.pipeline = (async (commands: Command[]) => (isStopWrite(commands) ? alter(commands) : real(commands))) as typeof redis.pipeline;
      try { await assert.rejects(() => stopFromLink(TOKEN, everyone)); }
      finally { redis.pipeline = real; }
    });
  }

  test(`stopFromLink (${scope}): the pitch read in an unknown shape writes nothing and is never "done"`, async () => {
    const statsId = await seedLink();
    const sent: Command[][] = [];
    redis.pipeline = (async (commands: Command[]) => { sent.push(commands); return commands[0]?.[0] === "HGET" ? [7] : real(commands); }) as typeof redis.pipeline;
    try { await assert.rejects(() => stopFromLink(TOKEN, everyone)); }
    finally { redis.pipeline = real; }
    assert.equal(sent.some(isStopWrite), false);
    assert.equal(redis.run(["SISMEMBER", `nl:outreach:${statsId}:stop`, "copperoak.com"]), 0);
  });

  test(`stopFromLink (${scope}): healthy, the stop is kept and said done`, async () => {
    const statsId = await seedLink();
    assert.equal(await stopFromLink(TOKEN, everyone), true);
    assert.equal(redis.run(["SISMEMBER", `nl:outreach:${statsId}:stop`, "copperoak.com"]), 1);
    assert.equal(redis.run(["SISMEMBER", "nl:outreach:stop:all", "copperoak.com"]), everyone ? 1 : 0);
    assert.equal(JSON.parse(String(redis.run(["HGET", pitchesKey(statsId), "0000000000000001"]))).status, "stopped");
  });
}

test("stopFromLink: a stop on a pitch already stopped (no HSET) still reads its SADD receipts", async () => {
  const statsId = await seedLink();
  redis.run(["HSET", pitchesKey(statsId), "0000000000000001", pitch("0000000000000001", "stopped")]);
  assert.equal(await stopFromLink(TOKEN, false), true);
  redis.pipeline = (async (commands: Command[]) => (isStopWrite(commands) ? [] : real(commands))) as typeof redis.pipeline;
  try { await assert.rejects(() => stopFromLink(TOKEN, false)); }
  finally { redis.pipeline = real; }
});
