/**
 * CX-123 rule 24, the two MÉDIO findings of Claude 6's review of #3069 (synthetic data only; fetch is stubbed, Meta is
 * never called):
 * 1. The studio's last read is shown only in the shape this code writes: a kept record with an amount missing, not a
 *    number, negative or fractional, or with a day or a count out of shape, is not "Read <day>: $0.00 over the last
 *    30 days"; metaView throws, so the Meta route answers 503.
 * 2. A reconnect gives back the old person's token, drops their index entry and deletes the old account's lines only
 *    once the new connection's write is confirmed ("OK" and a count for each of the other three commands). A write
 *    answered in no known shape keeps the old connection as it is and the reconnect answers an error.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { finishMeta, metaView } from "@/lib/meta-ads";
import { seal } from "@/lib/secret-box";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const NEW_USER = "10150000000000001";
const OLD_USER = "10150000000000077";
const revoked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  if (path === "/oauth/access_token") return json({ access_token: url.searchParams.get("grant_type") ? "EAAlong" : "EAAshort", expires_in: 5_184_000 });
  if (path === "/me/permissions" && method === "DELETE") {
    revoked.push(url.searchParams.get("access_token") ?? "?");
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: NEW_USER });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_111", account_id: "111", name: "Harbor Ads", currency: "USD", account_status: 1 }] });
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const today = new Date().toISOString().slice(0, 10);
const OWNER = "meta-read-record-exact@example.com";
const connKey = (s: string) => `nl:metaads:conn:${s}`;
const readKey = (s: string) => `nl:metaads:read:${s}`;
const userKey = (u: string) => `nl:metaads:user:${createHash("sha256").update(`metaads-user:${u}`).digest("hex").slice(0, 40)}`;
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function fresh() {
  redis.pipeline = real;
  redis.clear();
  revoked.length = 0;
  await claimHandle(OWNER, "meta-read-record", "Meta Read Record", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MetaReadRec", subscriptionId: "sub_MetaReadRec", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const token = seal("EAAoldworkingtoken", `metaads|${statsId}|token`);
  redis.run(["SET", connKey(statsId), JSON.stringify({ user: OLD_USER, token, accounts: [{ id: "act_999", name: "Old Ads", currency: "usd" }], account: "act_999", connectedAt: 1, sid: store.sid, owner: { email: OWNER, handle: store.handle }, broken: "" })]);
  redis.run(["SADD", userKey(OLD_USER), statsId]);
  return { statsId, sid: store.sid, handle: store.handle };
}

// ---- A. the last read's figures out of shape are shown as a real amount ----
for (const [label, record] of [
  ["no cents", { day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, campaigns: 1 }],
  ["cents not a number", { day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: "lots", campaigns: 1 }],
  ["cents null", { day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: null, campaigns: 1 }],
  ["cents negative", { day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: -500, campaigns: 1 }],
  ["cents fractional", { day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: 12.5, campaigns: 1 }],
  ["a day out of shape", { day: "yesterday", at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: 4200, campaigns: 1 }],
  ["no lines count", { day: today, at: 1_762_400_000, problem: "", after: 0, cents: 4200, campaigns: 1 }],
  ["a problem out of shape", { day: today, at: 1_762_400_000, problem: "late", after: 0, lines: 3, cents: 4200, campaigns: 1 }],
] as const) {
  test(`metaView: a last read with ${label} is unknown, never "Read ...: $0.00 over the last 30 days"`, async () => {
    const { statsId } = await fresh();
    redis.run(["SET", readKey(statsId), JSON.stringify(record)]);
    let view: unknown;
    let error: unknown;
    try {
      view = await metaView(statsId, "usd");
    } catch (e) {
      error = e;
    }
    assert.ok(error, `it throws instead of answering read=${JSON.stringify((view as { read?: unknown })?.read)} (the editor shows "Read <day>: $0.00 over the last 30 days")`);
  });
}

// ---- B. the new connection's write answered in no known shape ----
test("finishMeta: the new connection's SET answered in no known shape does not give back the old token nor answer connected", async () => {
  const { statsId, sid, handle } = await fresh();
  const before = redis.run(["GET", connKey(statsId)]);
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && commands[0]?.[0] === "SET" && commands[0][1] === connKey(statsId)) {
      used = true;
      return []; // no reply for the four commands: whether the SET landed is unknown (here it did not)
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let done: { ok: boolean } | undefined;
  let error: unknown;
  try {
    done = await finishMeta({ statsId, sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: OWNER, owner: { email: OWNER, handle }, currency: "usd" });
  } catch (e) {
    error = e;
  } finally {
    redis.pipeline = real;
  }
  const kept = redis.run(["GET", connKey(statsId)]);
  const facts = { ok: done?.ok, threw: Boolean(error), keptIsOld: kept === before, oldTokenRevoked: revoked.includes("EAAoldworkingtoken"), oldIndex: redis.run(["SISMEMBER", userKey(OLD_USER), statsId]) };
  assert.ok((error || done?.ok === false) && !facts.oldTokenRevoked && facts.oldIndex === 1, `a working connection is wiped on an unknown write: ${JSON.stringify(facts)}`);
});

test("finishMeta: the new connection's SET answered other than OK keeps the old connection and its token", async () => {
  const { statsId, sid, handle } = await fresh();
  const before = redis.run(["GET", connKey(statsId)]);
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && commands[0]?.[0] === "SET" && commands[0][1] === connKey(statsId)) {
      used = true;
      return [null, 0, 0, 0]; // a nil for the SET: not confirmed written
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let done: { ok: boolean } | undefined;
  let error: unknown;
  try {
    done = await finishMeta({ statsId, sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: OWNER, owner: { email: OWNER, handle }, currency: "usd" });
  } catch (e) {
    error = e;
  } finally {
    redis.pipeline = real;
  }
  assert.ok(error || done?.ok === false, "an unconfirmed write is never answered connected");
  assert.equal(redis.run(["GET", connKey(statsId)]), before);
  assert.equal(revoked.includes("EAAoldworkingtoken"), false);
  assert.equal(redis.run(["SISMEMBER", userKey(OLD_USER), statsId]), 1);
});

test("control: a healthy reconnect gives back the old token and connects", async () => {
  const { statsId, sid, handle } = await fresh();
  const done = await finishMeta({ statsId, sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: OWNER, owner: { email: OWNER, handle }, currency: "usd" });
  assert.equal(done.ok, true);
  assert.equal(revoked.includes("EAAoldworkingtoken"), true);
});

test("control: a whole last read is shown as it is", async () => {
  const { statsId } = await fresh();
  redis.run(["SET", readKey(statsId), JSON.stringify({ day: today, at: 1_762_400_000, problem: "", after: 0, lines: 3, cents: 4200, campaigns: 1 })]);
  assert.equal((await metaView(statsId, "usd"))?.read?.cents, 4200);
});
