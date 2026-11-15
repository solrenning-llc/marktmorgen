/**
 * Claude 5's second review of #2924 (rule 24), synthetic data only:
 * 1. A typed spend line is written only after the kept lines read exactly, so a 503 always means nothing was saved:
 *    a hash holding an entry in another shape refuses the add (no line written again and again behind a 503), and a
 *    read after the write that fails answers the lines known from the read before it, never 503 with the line saved.
 * 2. The weekly email takes ad spend only when every part of it read (spendsForReport): typed lines unread, or Meta's
 *    unread, leave the ad figures out, never one part shown as all of it or everything as $0.
 * 3. Disconnecting Meta reads the connection and the deletion exactly: an unknown reply is never "not connected"
 *    with the connection, its token and its lines still kept.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as adSpend from "@/lib/ad-spend";
import { disconnectMeta } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;

const { addSpend, readSpendLines } = adSpend;
const spendsForReport = (adSpend as Record<string, unknown>).spendsForReport as ((statsId: string | null) => Promise<{ cents: number }[]>) | undefined;
const today = new Date().toISOString().slice(0, 10);
const OWNER = "meta-spend-review@example.com";
const spendKey = (statsId: string) => `nl:stats:${statsId}:spend`;
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const linesKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const META_LINE = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 500, from: today, to: today };
const LINE = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function fresh(): Promise<string> {
  redis.clear();
  await claimHandle(OWNER, "meta-spend-review", "Meta Spend Review", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  redis.run(["SET", connKey(statsId), JSON.stringify({ user: "10150000000000077", token: "sealed", accounts: [{ id: "act_111", name: "Harbor Ads", currency: "usd" }], account: "act_111", sid: store.sid, owner: { email: OWNER, handle: store.handle } })]);
  redis.run(["SET", linesKey(statsId), JSON.stringify([META_LINE])]);
  return statsId;
}
async function settle<T>(work: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

test("1. a kept entry in another shape refuses the add: three tries write nothing", async () => {
  const statsId = await fresh();
  redis.run(["HSET", spendKey(statsId), "deadbeef", "{"]);
  for (let i = 0; i < 3; i += 1) {
    const tried = await settle(() => addSpend(statsId, LINE));
    assert.ok(tried.error || (tried.value && !tried.value.ok), "never answered as saved");
  }
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 1, "only the entry in another shape is there; nothing was written behind the refusals");
});

test("1. a read after the write that fails answers the lines known, never 'not saved' with the line saved", async () => {
  const statsId = await fresh();
  let wrote = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "HSET")) wrote = true;
    if (wrote && commands.length === 1 && commands[0][0] === "HGETALL") return [];
    return real(commands);
  }) as typeof redis.pipeline;
  const added = await settle(() => addSpend(statsId, LINE));
  redis.pipeline = real;
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 1, "the line is saved once");
  assert.equal(added.error, undefined, "so the add is not answered as failed");
  assert.equal(added.value?.ok, true);
  if (added.value?.ok) assert.deepEqual(added.value.spends.filter((s) => !s.source).map((s) => s.cents), [1200]);
});

test("1. control: a healthy add writes once and answers both kinds of line", async () => {
  const statsId = await fresh();
  const added = await addSpend(statsId, LINE);
  assert.equal(added.ok, true);
  if (added.ok) assert.deepEqual([added.metaUnread, added.spends.map((s) => s.cents).sort()], [false, [1200, 500]]);
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 1);
});

test("2. the weekly email's spend: whole, or none at all", async () => {
  assert.equal(typeof spendsForReport, "function", "lib/ad-spend.ts gives the weekly email its spend");
  const statsId = await fresh();
  await addSpend(statsId, LINE);
  assert.deepEqual((await spendsForReport!(statsId)).map((s) => s.cents).sort(), [1200, 500], "control: both parts");
  redis.pipeline = (async (commands: Command[]) =>
    commands[0]?.[0] === "EXISTS" && String(commands[0][1]).startsWith("nl:metaads:conn:") ? [] : real(commands)) as typeof redis.pipeline;
  const metaUnread = await settle(() => spendsForReport!(statsId));
  redis.pipeline = real;
  assert.deepEqual(metaUnread.value?.map((s) => s.cents), [], "Meta unread: no ad figures, never the typed $12 as all of it");
  redis.run(["HSET", spendKey(statsId), "deadbeef", "{"]);
  const typedUnread = await settle(() => spendsForReport!(statsId));
  assert.deepEqual(typedUnread.value?.map((s) => s.cents), [], "typed unread: no ad figures");
  const route = readFileSync(join(process.cwd(), "app/api/cron/weekly/route.ts"), "utf8");
  assert.equal(route.includes("spendsForReport("), true, "the weekly cron reads its spend through it");
  assert.equal(/readSpends\(store\.statsId\)\.catch\(\(\) => \[\]\)/.test(route), false, "never an unread spend as $0");
});

for (const [label, reply] of [["no reply", []], ["cut text", ["{"]], ["a number", [7]]] as const) {
  test(`3. disconnecting Meta: a connection read answering ${label} is never 'not connected'`, async () => {
    const statsId = await fresh();
    let used = false;
    redis.pipeline = (async (commands: Command[]) => {
      if (!used && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === connKey(statsId)) {
        used = true;
        return [...reply];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const gone = await settle(() => disconnectMeta(statsId));
    redis.pipeline = real;
    assert.ok(gone.error, "it throws, so the studio is told it could not be done");
    assert.equal(redis.run(["EXISTS", connKey(statsId)]), 1);
  });
}

test("3. disconnecting Meta: a deletion answered in no known shape is not 'disconnected'", async () => {
  const statsId = await fresh();
  redis.pipeline = (async (commands: Command[]) => (commands.length === 5 && commands[0][0] === "DEL" ? [] : real(commands))) as typeof redis.pipeline;
  const gone = await settle(() => disconnectMeta(statsId));
  redis.pipeline = real;
  assert.ok(gone.error);
});

test("3. control: a healthy disconnect forgets the connection and its lines", async () => {
  const statsId = await fresh();
  const gone = await disconnectMeta(statsId);
  assert.equal(gone && gone.id, "act_111");
  assert.equal(redis.run(["EXISTS", connKey(statsId)]), 0);
  assert.equal((await readSpendLines(statsId)).spends.length, 0);
});
