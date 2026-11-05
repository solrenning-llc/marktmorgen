/**
 * Meta's ad spend, read back in a shape that is not Meta's (CX-123 rule 24,
 * Claude 5, 05/11/2026). A 200 whose body is not JSON, a body without its
 * `data` list, or a next page that comes back so, is not "nothing was
 * spent": the read is not counted as done, and the days already read keep
 * their spend, so the store's numbers never show a cost of zero that Meta
 * never said. Synthetic only: a stand-in for the Graph API.
 */
import { createHmac } from "node:crypto";
import { finishMeta, readMetaSpend } from "@/lib/meta-ads";
import { readSpends } from "@/lib/ad-spend";
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
type Insights = "real" | "garbled" | "no-data" | "page2-garbled" | "rows-not-list" | "huge-spend" | "no-such-day" | "next-not-text" | "endless";
let insights: Insights = "real";

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
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_333", account_id: "333", name: "Shape Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_333/insights") {
    const second = url.searchParams.get("after") === "page2";
    if (insights === "garbled" && !second) return new Response("<html>Sorry, something went wrong.</html>", { status: 200 });
    if (insights === "no-data" && !second) return json({ paging: {} });
    if (insights === "rows-not-list" && !second) return json({ data: { campaign_id: "1" } });
    // Reviews of Codex G on #2681: rows the lines would leave out, a next page that is not a link, more pages than one read takes.
    if (insights === "huge-spend" && !second) return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "999999999999999.00", date_start: today, publisher_platform: "instagram" }] });
    if (insights === "no-such-day" && !second) return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "1.00", date_start: "2026-99-99", publisher_platform: "instagram" }] });
    if (insights === "next-not-text" && !second) return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "1.00", date_start: today, publisher_platform: "instagram" }], paging: { next: 123 } });
    if (insights === "endless") return json({ data: [], paging: { next: "https://graph.facebook.com/v25.0/act_333/insights?after=page2&access_token=x" } });
    if (second) return insights === "page2-garbled" ? new Response("", { status: 200 }) : json({ data: [] });
    return json({
      data: [{ campaign_id: "1", campaign_name: "Reel", spend: insights === "real" ? "30.00" : "1.00", date_start: today, publisher_platform: "instagram" }],
      paging: { next: "https://graph.facebook.com/v25.0/act_333/insights?after=page2&access_token=x" },
    });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const metaCents = async (statsId: string) => (await readSpends(statsId)).filter((s) => s.source === "meta").reduce((n, s) => n + s.cents, 0);

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle("metashape@example.com", "metashape", "Meta Shape", "");
  await ensureStatsId("metashape@example.com");
  const store = (await storeForEmail("metashape@example.com"))!;
  const statsId = store.statsId!;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: "metashape@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  if (!connected.ok) throw new Error(`not connected: ${connected.error}`);

  part("A real read first");
  is("read", await readMetaSpend(statsId, store.currency), "read");
  is("today's spend is $30.00", await metaCents(statsId), 3000);

  for (const shape of ["garbled", "no-data", "rows-not-list", "page2-garbled", "huge-spend", "no-such-day", "next-not-text", "endless"] as const) {
    part(`Insights answered ${shape}: not a read, nothing erased`);
    insights = shape;
    const result = await readMetaSpend(statsId, store.currency);
    is("not counted as read", result === "read", false);
    is("the spend already read is kept", await metaCents(statsId), 3000);
  }
  done();
}

void main();
