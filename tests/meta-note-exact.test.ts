/**
 * CX-123 rule 24, the MÉDIO finding of Claude 6's review of #3070 (synthetic data only; fetch is stubbed, Meta is never
 * called): a busy or failed try never writes an amount that was not read. A kept last read whose figures do not read
 * is replaced by a record that says it was not read yet (no day, so the studio shows no amount), never by one that
 * keeps its day with "$0.00".
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { finishMeta, metaView, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const today = new Date().toISOString().slice(0, 10);
let busy = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") return json({ success: true });
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: "10150000000000044" });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_333", account_id: "333", name: "Reads Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_333/insights" && insightsFail) return json({ error: { code: 100, message: "invalid parameter" } }, 400);
  if (path === "/act_333/insights") return busy ? json({ error: { code: 2, message: "busy" } }, 503) : json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "30.00", date_start: today, publisher_platform: "instagram" }] });
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;
console.error = () => {};

const OWNER = "meta-note-exact@example.com";
const readKey = (s: string) => `nl:metaads:read:${s}`;
const real = redis.pipeline.bind(redis);

async function fresh() {
  redis.pipeline = real;
  redis.clear();
  busy = false;
  await claimHandle(OWNER, "meta-note-exact", "Meta Note Exact", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: OWNER, owner: { email: store.email, handle: store.handle }, currency: store.currency });
  assert.ok(connected.ok, "connected");
  return { statsId, currency: store.currency };
}

let insightsFail = false;
for (const [label, record] of [
  ["no cents", { day: "2026-11-05", at: 1_762_300_000, problem: "", after: 0, lines: 3, campaigns: 1 }],
  ["cents not a number", { day: "2026-11-05", at: 1_762_300_000, problem: "", after: 0, lines: 3, cents: "lots", campaigns: 1 }],
  ["cents null", { day: "2026-11-05", at: 1_762_300_000, problem: "", after: 0, lines: 3, cents: null, campaigns: 1 }],
] as const) {
  for (const outcome of ["busy", "error"] as const) {
    test(`readMetaSpend: ${outcome === "error" ? "an" : "a"} ${outcome} try never turns a last read with ${label} into a kept "Read <day>: $0.00"`, async () => {
      const { statsId, currency } = await fresh();
      // A kept last read whose amount does not read (another shape): its amount is unknown.
      redis.run(["SET", readKey(statsId), JSON.stringify(record)]);
      busy = outcome === "busy";
      insightsFail = outcome === "error";
      try {
        assert.equal(await readMetaSpend(statsId, currency), outcome);
      } finally {
        busy = false;
        insightsFail = false;
      }
      const kept = JSON.parse(String(redis.run(["GET", readKey(statsId)]))) as Record<string, unknown>;
      const view = await metaView(statsId, currency).catch(() => null);
      assert.ok(!(kept.day && kept.cents === 0), `the ${outcome} note wrote ${JSON.stringify(kept)}; the studio is shown read=${JSON.stringify(view?.read)} ("Read November 5: $0.00 over the last 30 days")`);
      assert.equal(kept.problem, outcome);
    });
  }
}

test("control: a busy try keeps a whole last read's amount", async () => {
  const { statsId, currency } = await fresh();
  assert.equal(await readMetaSpend(statsId, currency), "read");
  busy = true;
  try {
    assert.equal(await readMetaSpend(statsId, currency), "busy");
  } finally {
    busy = false;
  }
  const read = (await metaView(statsId, currency))?.read;
  assert.equal(read?.cents, 3000);
  assert.equal(read?.problem, "busy");
});

test("control: a healthy read keeps its amount", async () => {
  const { statsId, currency } = await fresh();
  assert.equal(await readMetaSpend(statsId, currency), "read");
  assert.equal((await metaView(statsId, currency))?.read?.cents, 3000);
});
