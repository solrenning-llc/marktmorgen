import { readFileSync } from "node:fs";
/**
 * An ad account whose last 30 days hold more rows than one read of Meta's insights takes (20 pages of 500: 84
 * campaigns x 30 days x 4 platforms is already 10,080) can never be read whole: the read asks Meta its 20 pages and
 * then refuses the part, keeping what was read before (lib/meta-ads.ts, "Meta had more ad spend than one read takes").
 * That answer does not change an hour later. It was noted as "busy", which the five-minute job (readMetaDue) tries
 * again after an hour: 20 insights calls an hour, 480 a day, every day, against the creator's own ad account's rate
 * limit at Meta, none of which can ever succeed.
 *
 * What is checked, with a synthetic Graph API that always has another page: over a simulated day of the five-minute
 * job (288 runs), the too-big account is asked at most twice a day's worth of pages; nothing it kept is erased; and an
 * account Meta is merely busy for (a 500) is still tried again within the hour.
 */
import { createHmac } from "node:crypto";
import { finishMeta, readMetaDue, readMetaSpend } from "@/lib/meta-ads";
import { readSpends } from "@/lib/ad-spend";
import { claimHandle, ensureStatsId, storeForEmail, storeForId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const today = new Date().toISOString().slice(0, 10);
type Insights = "real" | "too-big" | "down";
let insights: Insights = "real";
let insightCalls = 0;

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

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
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_333", account_id: "333", name: "Big Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_333/insights") {
    insightCalls += 1;
    if (insights === "down") return json({ error: { code: 2, message: "Service temporarily unavailable" } }, 500);
    const row = { campaign_id: "1", campaign_name: "Reel", spend: "1.00", date_start: today, publisher_platform: "instagram" };
    if (insights === "too-big") return json({ data: [row], paging: { next: `https://graph.facebook.com/v25.0/act_333/insights?after=p${insightCalls}&access_token=x` } });
    return json({ data: [{ ...row, spend: "30.00" }] });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

const metaCents = async (statsId: string) => (await readSpends(statsId)).filter((s) => s.source === "meta").reduce((n, s) => n + s.cents, 0);

/** The five-minute job, every five minutes for `hours` hours from the simulated clock; the insights calls it made. */
async function runFor(hours: number): Promise<number> {
  const before = insightCalls;
  const runs = (hours * 60) / 5;
  for (let i = 0; i < runs; i += 1) {
    offset += 5 * 60_000;
    await readMetaDue(Date.now() + 5_000, storeForId);
  }
  return insightCalls - before;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle("metabig@example.com", "metabig", "Meta Big", "");
  await ensureStatsId("metabig@example.com");
  const store = (await storeForEmail("metabig@example.com"))!;
  const statsId = store.statsId!;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect: "https://marktmorgen.com/api/integrations/meta/callback", by: "metabig@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  if (!connected.ok) throw new Error(`not connected: ${connected.error}`);

  part("A real read first");
  is("read", await readMetaSpend(statsId, store.currency), "read");
  is("today's spend is $30.00", await metaCents(statsId), 3000);
  // The day's read is done: the next one is due once the reading's day is over.
  await redis.pipeline([["DEL", `nl:metaads:read:${statsId}`]]);

  part("An account with more rows than one read takes");
  insights = "too-big";
  const calls = await runFor(24);
  is("over a day of the five-minute job, Meta is asked at most two reads' worth of pages (before: 20 an hour, 480)", calls <= 40 ? "at most 40" : `${calls} calls`, "at most 40");
  is("and at least one read was tried", calls >= 20, true);
  is("the spend already read is kept", await metaCents(statsId), 3000);
  const noted = JSON.parse(String((await redis.pipeline([["GET", `nl:metaads:read:${statsId}`]]))[0] ?? "{}"));
  is("noted as too big, not as Meta being unreachable (review of #4167)", noted.problem, "big");
  const editor = readFileSync("components/ad-spend-editor.tsx", "utf8");
  is("the studio says when it tries again, without promising a few hours", editor.includes('read?.problem === "big"') && editor.includes("It tries again tomorrow."), true);

  part("Meta merely down is still tried again within the hour");
  insights = "down";
  offset += 2 * 86_400_000;
  await redis.pipeline([["DEL", `nl:metaads:read:${statsId}`]]);
  const first = await runFor(0.25);
  const again = await runFor(1.25);
  is("tried once", first, 1);
  is("and again after about an hour", again >= 1, true);

  Date.now = realNow;
  done();
}

void main();
