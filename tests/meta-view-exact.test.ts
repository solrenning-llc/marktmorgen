/**
 * CX-123 rule 24, the follow-ups #2924 left open (synthetic data only):
 * 1. metaView reads the connection and the last read exactly: an unknown reply, or a kept record in another shape, is
 *    never "not connected", never "no ad account" and never "read for the first time within the hour"; it throws, so
 *    the Meta route answers 503. A confirmed nil is still "not connected" / "not read yet".
 * 2. finishMeta reads the connection it replaces exactly: an unknown reply writes nothing (never the new connection
 *    over one it could not read, with the old person's token kept and the old account's lines counted under the new
 *    one), and the old account's lines are deleted only with a confirmed answer.
 * 3. A typed entry kept in another shape can be removed by its key, never by guessing its amount: the spend route says
 *    how many entries could not be read, and `{ action: "remove-unreadable" }` deletes exactly those fields, with a
 *    confirmed HDEL, keeping every readable entry.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { finishMeta, metaView } from "@/lib/meta-ads";
import { addSpend } from "@/lib/ad-spend";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as spendRoute } from "@/app/api/store/spend/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const NEW_USER = "10150000000000001";
const OLD_USER = "10150000000000077";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  if (path === "/oauth/access_token") return json({ access_token: url.searchParams.get("grant_type") ? "EAAlong" : "EAAshort", expires_in: 5_184_000 });
  if (path === "/me/permissions" && method === "DELETE") return json({ success: true });
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: NEW_USER });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_111", account_id: "111", name: "Harbor Ads", currency: "USD", account_status: 1 }] });
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const today = new Date().toISOString().slice(0, 10);
const OWNER = "meta-view-exact@example.com";
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const readKey = (statsId: string) => `nl:metaads:read:${statsId}`;
const linesKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const spendKey = (statsId: string) => `nl:stats:${statsId}:spend`;
const userKey = (user: string) => `nl:metaads:user:${createHash("sha256").update(`metaads-user:${user}`).digest("hex").slice(0, 40)}`;
const OLD_LINE = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 7700, from: today, to: today };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function fresh(connection: Record<string, unknown> | string = {}): Promise<{ statsId: string; sid: string; handle: string; cookie: string }> {
  redis.pipeline = real;
  redis.clear();
  await claimHandle(OWNER, "meta-view-exact", "Meta View Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MetaViewEx01", subscriptionId: "sub_MetaViewEx01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const record =
    typeof connection === "string"
      ? connection
      : JSON.stringify({ user: OLD_USER, token: "sealed", accounts: [{ id: "act_999", name: "Old Ads", currency: "usd" }], account: "act_999", sid: store.sid, owner: { email: OWNER, handle: store.handle }, ...connection });
  redis.run(["SET", connKey(statsId), record]);
  redis.run(["SET", linesKey(statsId), JSON.stringify([OLD_LINE])]);
  redis.run(["SADD", userKey(OLD_USER), statsId]);
  return { statsId, sid: store.sid, handle: store.handle, cookie: `${SESSION_COOKIE}=${await openSession(OWNER)}` };
}

/** The first pipeline that `match` names is answered with `reply`; every other goes to the stub. */
function answerOnce(match: (commands: Command[]) => boolean, reply: unknown): void {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && match(commands)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}

async function settle<T>(work: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = real;
  }
}

const viewRead = (statsId: string) => (commands: Command[]) => commands.length === 2 && commands[0][0] === "GET" && commands[0][1] === connKey(statsId);

// ---- 1. metaView ---------------------------------------------------------------------------------------------------

for (const [label, reply] of [
  ["no reply", []],
  ["one reply for two reads", ["{}"]],
  ["a connection that is not text", [7, null]],
  ["a connection cut short", ["{", null]],
  ["a last read cut short", [undefined, "{"]],
  ["a last read that is not a record", [undefined, "5"]],
] as const) {
  test(`metaView: ${label} is unknown, never "not connected" or "not read yet"`, async () => {
    const { statsId } = await fresh();
    const [conn] = await real([["GET", connKey(statsId)]]);
    const answer = (reply as readonly unknown[]).map((r, i) => (i === 0 && r === undefined ? conn : r));
    answerOnce(viewRead(statsId), answer);
    const seen = await settle(() => metaView(statsId, "usd"));
    assert.ok(seen.error, `it throws instead of answering ${JSON.stringify(seen.value)}`);
  });
}

test('metaView: a kept connection whose ad account is in another shape is unknown, never "no ad account"', async () => {
  const { statsId } = await fresh({ accounts: [{ id: "act_999", name: "Old Ads", currency: 5 }] });
  const seen = await settle(() => metaView(statsId, "usd"));
  assert.ok(seen.error, `it throws instead of answering ${JSON.stringify(seen.value)}`);
});

test("metaView: confirmed absence and a healthy connection read as they are", async () => {
  const { statsId } = await fresh();
  const view = (await metaView(statsId, "usd"))!;
  assert.deepEqual([view.connected, view.account?.id, view.read], [true, "act_999", null], "connected, nothing read yet: read is null only for a nil");
  redis.run(["SET", readKey(statsId), JSON.stringify({ day: today, at: 1, problem: "", after: 0, lines: 1, cents: 7700, campaigns: 1 })]);
  assert.equal((await metaView(statsId, "usd"))?.read?.cents, 7700);
  redis.run(["DEL", connKey(statsId)]);
  assert.equal((await metaView(statsId, "usd"))?.connected, false, "a confirmed nil is not connected");
});

// ---- 2. finishMeta -------------------------------------------------------------------------------------------------

const connectInput = (statsId: string, sid: string, handle: string) => ({
  statsId,
  sid,
  code: "good-code",
  redirect: "https://marktmorgen.com/api/integrations/meta/callback",
  by: OWNER,
  owner: { email: OWNER, handle },
  currency: "usd",
});
const connRead = (statsId: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === connKey(statsId);

for (const [label, reply] of [
  ["no reply", []],
  ["a connection that is not text", [7]],
  ["a connection cut short", ["{"]],
] as const) {
  test(`finishMeta: the connection it replaces answering ${label} writes nothing`, async () => {
    const { statsId, sid, handle } = await fresh();
    const before = redis.run(["GET", connKey(statsId)]);
    answerOnce(connRead(statsId), [...reply]);
    const done = await settle(() => finishMeta(connectInput(statsId, sid, handle)));
    assert.ok(done.error || (done.value && !done.value.ok), "never answered as connected");
    assert.equal(redis.run(["GET", connKey(statsId)]), before, "the kept connection is not replaced by one written over an unknown");
    assert.equal(redis.run(["EXISTS", linesKey(statsId)]), 1, "nothing deleted either");
  });
}

test("finishMeta: the old account's lines deleted with no known answer is not 'connected'", async () => {
  const { statsId, sid, handle } = await fresh();
  answerOnce((commands) => commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === linesKey(statsId), []);
  const done = await settle(() => finishMeta(connectInput(statsId, sid, handle)));
  assert.ok(done.error || (done.value && !done.value.ok), "the old account's lines may still be counted under the new one");
});

test("finishMeta control: replacing another person's connection gives it back and drops the old account's lines", async () => {
  const { statsId, sid, handle } = await fresh();
  const done = await finishMeta(connectInput(statsId, sid, handle));
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.account?.id, "act_111");
  assert.equal(redis.run(["EXISTS", linesKey(statsId)]), 0, "the old account's $77 is not counted under the new one");
  assert.equal(JSON.parse(String(redis.run(["GET", connKey(statsId)]))).user, NEW_USER);
  assert.deepEqual([redis.run(["SISMEMBER", userKey(OLD_USER), statsId]), redis.run(["SISMEMBER", userKey(NEW_USER), statsId])], [0, 1], "only the new person's index names the store");
});

test("finishMeta control: no connection kept before (a confirmed nil) connects", async () => {
  const { statsId, sid, handle } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  const done = await finishMeta(connectInput(statsId, sid, handle));
  assert.equal(done.ok, true);
});

// ---- 3. an unreadable typed entry --------------------------------------------------------------------------------

const LINE = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };
async function post(cookie: string, body: Record<string, unknown>): Promise<{ status: number; answer: Record<string, unknown> }> {
  const response = await spendRoute(
    new NextRequest("https://marktmorgen.com/api/store/spend", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: response.status, answer: (await response.json()) as Record<string, unknown> };
}

test("the spend route says how many kept entries could not be read, and removes exactly those by key", async () => {
  const { statsId, cookie } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  assert.equal((await addSpend(statsId, LINE)).ok, true);
  redis.run(["HSET", spendKey(statsId), "deadbeef", "{"]);
  const refused = await post(cookie, { action: "add", ...LINE });
  assert.deepEqual([refused.status, refused.answer.error, refused.answer.unreadable], [503, "unread", 1], "the add is refused and says one entry could not be read");
  const removed = await post(cookie, { action: "remove-unreadable" });
  assert.equal(removed.status, 200);
  assert.deepEqual((removed.answer.spends as { cents: number }[]).map((s) => s.cents), [1200], "the readable entry is kept and answered");
  assert.equal(redis.run(["HEXISTS", spendKey(statsId), "deadbeef"]), 0, "the unreadable field is gone");
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 1);
  assert.equal((await post(cookie, { action: "add", ...LINE })).status, 200, "and adding works again");
});

test("removing unreadable entries: a hash read in no known shape removes nothing", async () => {
  const { statsId, cookie } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  await addSpend(statsId, LINE);
  redis.run(["HSET", spendKey(statsId), "deadbeef", "{"]);
  answerOnce((commands) => commands.length === 1 && commands[0][0] === "HGETALL", []);
  const removed = await post(cookie, { action: "remove-unreadable" }).finally(() => (redis.pipeline = real));
  assert.deepEqual([removed.status, removed.answer.error, removed.answer.unreadable], [503, "unread", undefined]);
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 2, "nothing removed on a guess");
});

test("removing unreadable entries: an HDEL answered in no known shape is not 'removed'", async () => {
  const { statsId, cookie } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  redis.run(["HSET", spendKey(statsId), "deadbeef", "{"]);
  answerOnce((commands) => commands.length === 1 && commands[0][0] === "HDEL", []);
  const removed = await post(cookie, { action: "remove-unreadable" }).finally(() => (redis.pipeline = real));
  assert.equal(removed.status, 503);
});

test("removing unreadable entries control: with every entry readable, nothing is removed", async () => {
  const { statsId, cookie } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  await addSpend(statsId, LINE);
  const removed = await post(cookie, { action: "remove-unreadable" });
  assert.equal(removed.status, 200);
  assert.equal(redis.run(["HLEN", spendKey(statsId)]), 1);
});

test("the spend editor offers the removal by key, with its own words", () => {
  const editor = readFileSync(join(process.cwd(), "components/ad-spend-editor.tsx"), "utf8");
  assert.equal(editor.includes('action: "remove-unreadable"'), true);
  assert.equal(/could not be read, so its amount is unknown/.test(editor), true);
});
