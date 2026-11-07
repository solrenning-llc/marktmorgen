/**
 * CX-123 rule 24, the readers #3069 left lenient (synthetic data only): readMetaSpend, chooseAccount and markBroken read
 * the Meta connection exactly, with the reader metaView and finishMeta use.
 * 1. readMetaSpend: an unknown reply, or a kept record in another shape, is never "not connected" ("none"), never a
 *    chosen account dropped, never a connection taken as healthy; it throws before Meta is asked. Its check that the
 *    connection is still there before the lines are written, and the write itself, are confirmed, never a "none" or a
 *    "read" by guess.
 * 2. chooseAccount: an unknown reply is never "not one of your accounts" (a 400); a record with an account out of shape
 *    is never rewritten with that account dropped; a write not answered in its shape is never "chosen". The Meta route
 *    answers 503.
 * 3. markBroken: the connection it marks is read exactly and the mark is confirmed before the owner is told, so a
 *    connection is never said broken without the mark kept, nor left healthy by guess.
 * 4. readMetaDue skips a store whose connection is out of shape and still reads the others.
 * A confirmed nil stays "none" / false, and the healthy paths still work.
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { UnknownReplyError } from "@/lib/redis-reply";
import { chooseAccount, finishMeta, readMetaDue, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail, storeForId } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as metaAdsRoute } from "@/app/api/store/meta-ads/route";
import { store as redis } from "./redis-stub";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const today = new Date().toISOString().slice(0, 10);
let insightCalls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  const token = url.searchParams.get("access_token");
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") return json({ success: true });
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: "10150000000000044" });
  if (path === "/me/adaccounts")
    return json({ data: [{ id: "act_333", account_id: "333", name: "Reads Ads", currency: "USD", account_status: 1 }, { id: "act_444", account_id: "444", name: "Other Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_333/insights" || path === "/act_444/insights") {
    insightCalls += 1;
    return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "30.00", date_start: today, publisher_platform: "instagram" }] });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;
console.error = () => {};

const OWNER = "meta-reads-exact@example.com";
const connKey = (statsId: string) => `nl:metaads:conn:${statsId}`;
const linesKey = (statsId: string) => `nl:stats:${statsId}:spend:meta`;
const OLD_LINE = { id: "meta-0123456789ab", channel: "facebook", campaign: "", cents: 7700, from: today, to: today };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

/** A store connected to Meta through the real callback, so its token is sealed; `edit` changes the kept record. */
async function fresh(edit?: (record: Record<string, unknown>) => Record<string, unknown>): Promise<{ statsId: string; currency: string; handle: string }> {
  redis.pipeline = real;
  redis.clear();
  await claimHandle(OWNER, "meta-reads-exact", "Meta Reads Exact", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: OWNER, owner: { email: store.email, handle: store.handle }, currency: store.currency });
  assert.ok(connected.ok, "connected");
  const [raw] = await real([["GET", connKey(statsId)]]);
  const record = JSON.parse(String(raw)) as Record<string, unknown>;
  // Two accounts, so the studio asks which one; the test picks act_333 unless `edit` says otherwise.
  const kept = { ...record, account: "act_333" };
  redis.run(["SET", connKey(statsId), JSON.stringify(edit ? edit(kept) : kept)]);
  redis.run(["SET", linesKey(statsId), JSON.stringify([OLD_LINE])]);
  insightCalls = 0;
  return { statsId, currency: store.currency, handle: store.handle };
}

const conn = async (statsId: string) => JSON.parse(String((await real([["GET", connKey(statsId)]]))[0])) as Record<string, unknown>;
const lines = async (statsId: string) => JSON.parse(String((await real([["GET", linesKey(statsId)]]))[0])) as { id: string }[];

/** The `nth` (from 1) pipeline that `match` names is answered with `reply` (the real reply goes through `reply` when it is a function). */
function answerNth(match: (commands: Command[]) => boolean, nth: number, reply: unknown): void {
  let seen = 0;
  redis.pipeline = (async (commands: Command[]) => {
    if (match(commands) && ++seen === nth) {
      if (typeof reply === "function") return (reply as (real: unknown[]) => unknown)(await real(commands));
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

const connGet = (statsId: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === connKey(statsId);
const connSet = (statsId: string) => (commands: Command[]) => commands[0]?.[0] === "SET" && commands[0][1] === connKey(statsId);
const linesSet = (statsId: string) => (commands: Command[]) => commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === linesKey(statsId);
const ODD: [string, unknown][] = [["no reply", []], ["a number", [7]], ["a record cut short", ["{"]], ["a list", [["x"]]]];

// ---- 1. readMetaSpend ------------------------------------------------------------------------------------------------

test("readMetaSpend, healthy: the chosen account is read", async () => {
  const { statsId, currency } = await fresh();
  assert.equal(await readMetaSpend(statsId, currency), "read");
  assert.equal(insightCalls, 1);
});

test("readMetaSpend, confirmed nil: not connected is still none", async () => {
  const { statsId, currency } = await fresh();
  redis.run(["DEL", connKey(statsId)]);
  assert.equal(await readMetaSpend(statsId, currency), "none");
  assert.equal(insightCalls, 0);
});

for (const [label, reply] of ODD) {
  test(`readMetaSpend: ${label} for the connection is unknown, never "none", and Meta is not asked`, async () => {
    const { statsId, currency } = await fresh();
    answerNth(connGet(statsId), 1, reply);
    const seen = await settle(() => readMetaSpend(statsId, currency));
    assert.ok(seen.error instanceof UnknownReplyError, `it throws instead of answering ${JSON.stringify(seen.value)}`);
    assert.equal(insightCalls, 0);
  });
}

for (const [label, edit] of [
  ["the chosen account kept in another shape", (r: Record<string, unknown>) => ({ ...r, accounts: [{ id: "act_333", name: "Reads Ads", currency: 840 }, { id: "act_444", name: "Other Ads", currency: "usd" }] })],
  ["the chosen account not a text", (r: Record<string, unknown>) => ({ ...r, account: 333 })],
  ["the chosen account not among the kept ones", (r: Record<string, unknown>) => ({ ...r, account: "act_555" })],
  ["why it broke not a text", (r: Record<string, unknown>) => ({ ...r, broken: true })],
  ["when it runs out not a number", (r: Record<string, unknown>) => ({ ...r, expires: "soon" })],
] as const) {
  test(`readMetaSpend: ${label} is unknown, never "none" and never read as healthy`, async () => {
    const { statsId, currency } = await fresh(edit);
    const seen = await settle(() => readMetaSpend(statsId, currency));
    assert.ok(seen.error instanceof UnknownReplyError, `it throws instead of answering ${JSON.stringify(seen.value)}`);
    assert.equal(insightCalls, 0);
  });
}

test('readMetaSpend: the connection unknown just before the lines are written is never "none", and the kept lines stay', async () => {
  const { statsId, currency } = await fresh();
  answerNth(connGet(statsId), 2, []);
  const seen = await settle(() => readMetaSpend(statsId, currency));
  assert.equal(seen.value, "error", `answers ${JSON.stringify(seen)}`);
  assert.deepEqual((await lines(statsId)).map((l) => l.id), [OLD_LINE.id]);
});

test('readMetaSpend: the lines written but not answered in their shape are never "read"', async () => {
  const { statsId, currency } = await fresh();
  answerNth(linesSet(statsId), 1, (got: unknown[]) => got.map(() => 1));
  const seen = await settle(() => readMetaSpend(statsId, currency));
  assert.equal(seen.value, "error", `answers ${JSON.stringify(seen)}`);
});

// ---- 2. chooseAccount ------------------------------------------------------------------------------------------------

test("chooseAccount, healthy: another of the kept accounts is chosen; a confirmed nil is false", async () => {
  const { statsId } = await fresh();
  assert.equal(await chooseAccount(statsId, "act_444"), true);
  assert.equal((await conn(statsId)).account, "act_444");
  assert.equal(await chooseAccount(statsId, "act_999"), false);
  redis.run(["DEL", connKey(statsId)]);
  assert.equal(await chooseAccount(statsId, "act_444"), false);
});

for (const [label, reply] of ODD) {
  test(`chooseAccount: ${label} for the connection is unknown, never "not one of your accounts"`, async () => {
    const { statsId } = await fresh();
    answerNth(connGet(statsId), 1, reply);
    const seen = await settle(() => chooseAccount(statsId, "act_444"));
    assert.ok(seen.error instanceof UnknownReplyError, `it throws instead of answering ${JSON.stringify(seen.value)}`);
    assert.equal((await conn(statsId)).account, "act_333");
  });
}

test("chooseAccount: a record with an account out of shape is never rewritten with that account dropped", async () => {
  const { statsId } = await fresh((r) => ({ ...r, accounts: [{ id: "act_333", name: "Reads Ads", currency: "usd" }, { id: "act_444", name: "Other Ads", currency: "usd" }, { id: "act_777", currency: 5 }] }));
  const before = await conn(statsId);
  const seen = await settle(() => chooseAccount(statsId, "act_444"));
  assert.ok(seen.error instanceof UnknownReplyError, `it throws instead of answering ${JSON.stringify(seen.value)}`);
  assert.deepEqual(await conn(statsId), before);
});

test('chooseAccount: a choice written but not answered in its shape is never "chosen"', async () => {
  const { statsId } = await fresh();
  answerNth(connSet(statsId), 1, (got: unknown[]) => got.map(() => "?"));
  const seen = await settle(() => chooseAccount(statsId, "act_444"));
  assert.ok(seen.error instanceof UnknownReplyError, `it throws instead of answering ${JSON.stringify(seen.value)}`);
});

test("the Meta route answers 503 when the connection cannot be read, never 400 \"account\"", async () => {
  const { statsId } = await fresh();
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  answerNth(connGet(statsId), 1, []);
  const response = await settle(() =>
    metaAdsRoute(
      new NextRequest("https://marktmorgen.com/api/store/meta-ads", {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "account", id: "act_444" }),
      }),
    ),
  );
  assert.equal(response.value?.status, 503);
  assert.deepEqual(await response.value?.json(), { ok: false, error: "unavailable" });
});

// ---- 3. markBroken ---------------------------------------------------------------------------------------------------

const expired = (r: Record<string, unknown>) => ({ ...r, expires: Math.floor(Date.now() / 1000) - 60 });

test("markBroken, healthy: a token that ran out marks the connection broken and tells the owner once", async () => {
  const { statsId, currency } = await fresh(expired);
  let told = 0;
  assert.equal(await readMetaSpend(statsId, currency, Date.now(), async () => void (told += 1)), "broken");
  assert.ok(String((await conn(statsId)).broken).length > 0);
  assert.equal(told, 1);
});

for (const [label, reply] of ODD) {
  test(`markBroken: ${label} for the connection it marks is never "broken" unmarked, and the owner is not told`, async () => {
    const { statsId, currency } = await fresh(expired);
    let told = 0;
    // The first GET is readMetaSpend's own; the second is markBroken's.
    answerNth(connGet(statsId), 2, reply);
    const seen = await settle(() => readMetaSpend(statsId, currency, Date.now(), async () => void (told += 1)));
    assert.notEqual(seen.value, "broken", "never broken without the mark");
    assert.equal(told, 0);
    assert.equal((await conn(statsId)).broken, "");
  });
}

test("markBroken: a mark not answered in its shape is never told to the owner as broken", async () => {
  const { statsId, currency } = await fresh(expired);
  let told = 0;
  answerNth(connSet(statsId), 1, (got: unknown[]) => got.map(() => null));
  const seen = await settle(() => readMetaSpend(statsId, currency, Date.now(), async () => void (told += 1)));
  assert.notEqual(seen.value, "broken");
  assert.equal(told, 0);
});

// ---- 4. readMetaDue --------------------------------------------------------------------------------------------------

test("readMetaDue: a store whose kept connection is out of shape is skipped, never read as healthy", async () => {
  const { statsId } = await fresh((r) => ({ ...r, broken: true }));
  redis.run(["SADD", "nl:metaads:stores", statsId]);
  const counts = await readMetaDue(Date.now() + 5_000, async (sid) => {
    const s = await storeForId(sid);
    return s ? { statsId: s.statsId, currency: s.currency, email: s.email, handle: s.handle } : null;
  });
  assert.deepEqual(counts, { read: 0, skipped: 1 });
  assert.equal(insightCalls, 0);
});
