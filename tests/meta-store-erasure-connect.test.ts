/**
 * #5010 row 117 (Codex L-20261119-2124): Meta's OAuth return (lib/meta-ads.ts finishMeta) asks Meta for the token, the
 * person and the ad accounts, and only then keeps the connection: the sealed token, the Meta user, the accounts and the
 * owner's addresses, with no expiry, and the store in both indexes. The whole store's erasure can begin or end while
 * Meta answers. FINISH_UNLESS_GONE v2 checks the store's fence (lib/live-fence.ts) in the same step as it keeps the
 * connection, so an erasure that won keeps nothing. Checked, through the real finishMeta and Redis stand-in:
 *   - a live store: connected, as before;
 *   - the store's erasure begun (its erasing mark set) while Meta answered: "closed", nothing kept, nothing indexed;
 *   - the store erased (its id key gone) while Meta answered: the same;
 *   - its Meta permission is not given back for it (the same login may serve another store; #4159);
 *   - with no store passed, the store is read by its id, and a store gone keeps nothing;
 *   - the store's fence costs two calls more inside the one script, and no command outside it.
 * Synthetic: the in-memory Redis and a Graph stand-in; no network.
 */
import { createHash, createHmac } from "node:crypto";
import { finishMeta } from "@/lib/meta-ads";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000117";
/** Run while Meta answers the ad accounts: the store's erasure, in the middle of the flow. */
let during: (() => Promise<void>) | null = null;
let gaveBack = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  const method = init?.method ?? "GET";
  const token = url.searchParams.get("access_token");
  if (token && url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(token).digest("hex")) return json({ error: { code: 190 } }, 400);
  if (path === "/oauth/access_token") return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  if (path === "/me/permissions" && method === "DELETE") {
    gaveBack += 1;
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me") return json({ id: USER });
  if (path === "/me/adaccounts") {
    if (during) {
      const run = during;
      during = null;
      await run();
    }
    return json({ data: [{ id: "act_117", account_id: "117", name: "Erased Ads", currency: "USD", account_status: 1 }] });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const userIndex = `nl:metaads:user:${createHash("sha256").update(`metaads-user:${USER}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  console.error = () => {};
  const OWNER = "meta-erasure@example.com";
  const fresh = async () => {
    redis.clear();
    await claimHandle(OWNER, "metaerasure", "Meta Erasure", "");
    await ensureStatsId(OWNER);
    await ensureStoreId(OWNER);
    const store = (await storeForEmail(OWNER))!;
    gaveBack = 0;
    return store;
  };
  const input = (store: Awaited<ReturnType<typeof fresh>>, withStore: boolean) => ({
    statsId: store.statsId!, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback",
    by: OWNER, owner: { email: store.email, handle: store.handle }, currency: store.currency, startedAt: Date.now(), ...(withStore ? { store } : {}),
  });
  const left = async (statsId: string) => (await redis.pipeline([["EXISTS", `nl:metaads:conn:${statsId}`], ["SISMEMBER", "nl:metaads:stores", statsId], ["SISMEMBER", userIndex, statsId]])).map(Number);

  part("A live store: connected, as before");
  {
    const store = await fresh();
    const calls = redis.scriptCalls;
    const result = await finishMeta(input(store, true));
    is("connected", result.ok, true);
    is("the connection and both indexes kept", await left(store.statsId!), [1, 1, 1]);
    is("the script ran its two fence calls with its nine others at the most", redis.scriptCalls - calls <= 11, true);
  }

  part("The store's erasure begun while Meta answered: nothing kept");
  {
    const store = await fresh();
    during = async () => { await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]); };
    const result = await finishMeta(input(store, true));
    is("closed", result.ok ? "connected" : result.error, "closed");
    is("no connection, and the store in neither index", await left(store.statsId!), [0, 0, 0]);
    is("its Meta permission is not given back for it", gaveBack, 0);
  }

  part("The store erased while Meta answered: nothing kept");
  {
    const store = await fresh();
    during = async () => { await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]]]); };
    const result = await finishMeta(input(store, true));
    is("closed", result.ok ? "connected" : result.error, "closed");
    is("no connection, and the store in neither index", await left(store.statsId!), [0, 0, 0]);
  }

  part("With no store passed, the store is read by its id");
  {
    const live = await fresh();
    is("a live store connects", (await finishMeta(input(live, false))).ok, true);
    const store = await fresh();
    await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]]]);
    const result = await finishMeta(input(store, false));
    is("a store gone keeps nothing", [result.ok ? "connected" : result.error, ...(await left(store.statsId!))], ["closed", 0, 0, 0]);
  }

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
