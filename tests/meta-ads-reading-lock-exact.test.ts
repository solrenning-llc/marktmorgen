/**
 * Meta's reading lock is read exactly (CX-123 rule 24, lib/meta-ads.ts readMetaSpend; lib/claim-mark.ts): "OK" is
 * this read's, nil is a read already under way ("busy"). Any other answer, or none, is read back: the lock holding
 * this read's own value is ours, another value is the other read's, anything else is unknown, so Meta is not asked
 * this time ("busy", tried again later) and the lock this read may have taken is let go, only while it holds this
 * read's value. A read lets go only of its own lock, never one taken by the next read.
 *
 * Before: any reply but nil was the lock won, so a malformed reply read Meta a second time beside the read already
 * under way, and its end deleted that read's lock.
 */
import { createHmac } from "node:crypto";
import { finishMeta, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const today = new Date().toISOString().slice(0, 10);
/** Each time Meta's ad spend is asked for: what the lock is there to keep to one at a time. */
let insightCalls = 0;
/** Set while Meta is being read: a lock another read takes once this read's lock ran out. */
let duringRead: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v25\.0/, "");
  const method = init?.method ?? "GET";
  const token = url.searchParams.get("access_token");
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") return json({ success: true });
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: "10150000000000002" });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_333", account_id: "333", name: "Lock Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_333/insights") {
    insightCalls += 1;
    if (duringRead) await duringRead();
    return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "30.00", date_start: today, publisher_platform: "instagram" }] });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

/** How the lock's SET NX is answered ("real", "drop", "throw" or a value in its place); `readBack` likewise for a GET of it. */
let lockReply: unknown = "real";
let readBack: unknown = "real";
let target = "";
const pipeline = redis.pipeline.bind(redis);
const shaped = (real: unknown[], at: number, how: unknown): unknown[] => {
  if (how === "throw") throw new Error("synthetic: connection reset");
  if (how === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? how : r));
};
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  const nx = commands.findIndex((c) => c[0] === "SET" && c[1] === target && c.includes("NX"));
  if (nx >= 0 && lockReply !== "real") return shaped(real, nx, lockReply);
  const get = commands.length === 1 ? commands.findIndex((c) => c[0] === "GET" && c[1] === target) : -1;
  if (get >= 0 && readBack !== "real") return shaped(real, get, readBack);
  return real;
}) as typeof redis.pipeline;
const reset = () => {
  lockReply = "real";
  readBack = "real";
  target = "";
};
const ODD: [string, unknown][] = [["no reply", "drop"], ["a number", 1], ["a list", ["OK"]], ["an empty string", ""], ["the request failed", "throw"]];
const OTHER = "1730000000000.000000001";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle("metalock@example.com", "metalock", "Meta Lock", "");
  await ensureStatsId("metalock@example.com");
  const store = (await storeForEmail("metalock@example.com"))!;
  const statsId = store.statsId!;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: "metalock@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  if (!connected.ok) throw new Error(`not connected: ${connected.error}`);
  const lock = `nl:metaads:reading:${statsId}`;
  const held = async () => (await pipeline([["GET", lock]]))[0];

  part("healthy: a read asks Meta once and lets its lock go");
  insightCalls = 0;
  is("read", await readMetaSpend(statsId, store.currency), "read");
  is("Meta asked once", insightCalls, 1);
  is("the lock let go", await held(), null);

  part("a read under way (its lock held): nil is busy, Meta not asked");
  await pipeline([["SET", lock, OTHER, "EX", 90]]);
  insightCalls = 0;
  is("busy", await readMetaSpend(statsId, store.currency), "busy");
  is("Meta not asked", insightCalls, 0);

  part("a read under way: a malformed answer never reads Meta a second time");
  for (const [label, odd] of ODD) {
    await pipeline([["SET", lock, OTHER, "EX", 90]]);
    target = lock;
    lockReply = odd;
    insightCalls = 0;
    const got = await readMetaSpend(statsId, store.currency).catch(() => "threw");
    reset();
    is(`${label}: busy`, got, "busy");
    is(`${label}: Meta not asked`, insightCalls, 0);
    is(`${label}: the other read's lock is kept`, await held(), OTHER);
  }
  await pipeline([["DEL", lock]]);

  part("a lock that landed but was answered oddly is read back as ours: Meta read once");
  for (const [label, odd] of ODD) {
    target = lock;
    lockReply = odd;
    insightCalls = 0;
    const got = await readMetaSpend(statsId, store.currency).catch(() => "threw");
    reset();
    is(`${label}: read once`, [got, insightCalls], ["read", 1]);
    is(`${label}: the lock let go`, await held(), null);
  }

  part("a lock that cannot be read back is unknown: Meta not asked, the lock let go");
  for (const [label, odd] of ODD) {
    target = lock;
    lockReply = odd;
    readBack = "throw";
    insightCalls = 0;
    const got = await readMetaSpend(statsId, store.currency).catch(() => "threw");
    reset();
    is(`${label}: busy, tried again later`, [got, insightCalls], ["busy", 0]);
    is(`${label}: the lock is not held`, await held(), null);
  }

  part("a read whose lock ran out never deletes the next read's lock");
  await pipeline([["DEL", lock]]);
  duringRead = async () => {
    await pipeline([["SET", lock, OTHER, "EX", 90]]);
  };
  is("read", await readMetaSpend(statsId, store.currency), "read");
  duringRead = null;
  is("the next read's lock is kept", await held(), OTHER);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
