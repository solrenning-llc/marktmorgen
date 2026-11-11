/**
 * Rule 24 in the ad spend kept for the numbers:
 *
 *   - readMetaSpend (lib/meta-ads.ts): the lines kept from earlier reads (GET) read in another shape are unknown: the
 *     read stops and nothing is written, never an empty history merged with the new window and written over the
 *     kept one, which erased every day outside the window;
 *   - addSpend (lib/ad-spend.ts): over the cap, the typed lines kept are read exactly before the oldest are trimmed;
 *     a reply in another shape trims nothing, never "keep none" that deleted every typed line, the new one too.
 *
 * Synthetic only: a stand-in for Meta's Graph API.
 */
import { createHmac } from "node:crypto";
import { linesFrom, mergeLines, minorUnits, platformChannel } from "@/lib/meta-ads-rules";
import { spendWithin, typedOverlap } from "@/lib/ad-spend-rules";
import {
  accountToUse,
  beginMeta,
  finishMeta,
  graphVersion,
  linesKey,
  metaView,
  readMetaSpend,
  takeMeta,
} from "@/lib/meta-ads";
import { addSpend, readSpends } from "@/lib/ad-spend";
import { MAX_SPEND_ENTRIES } from "@/lib/ad-spend-rules";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { sourceAlias } from "@/lib/source-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000001";
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const accounts: Record<string, unknown>[] = [{ id: "act_111", account_id: "111", name: "Harbor Ads", currency: "USD", account_status: 1 }];
const refuse = false;
let adsRead = true;
const revoked: string[] = [];
const proofs: boolean[] = [];
const asked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "graph.facebook.com") return json({ object: "list", data: [], has_more: false });
  is("provider requests use the supported Marketing API version", url.pathname.startsWith("/v25.0/"), true);
  const path = url.pathname.replace(/^\/v25\.0/, "");
  const method = init?.method ?? "GET";
  asked.push(`${method} ${path}`);
  const token = url.searchParams.get("access_token");
  if (token) proofs.push(url.searchParams.get("appsecret_proof") === createHmac("sha256", SECRET).update(token).digest("hex"));
  if (path === "/oauth/access_token") {
    if (url.searchParams.get("grant_type") === "fb_exchange_token") return json({ access_token: "EAAlong", token_type: "bearer", expires_in: 5_184_000 });
    return url.searchParams.get("code") === "good-code" ? json({ access_token: "EAAshort" }) : json({ error: { code: 100, message: "Invalid verification code" } }, 400);
  }
  if (refuse) return json({ error: { code: 190, message: "Error validating access token" } }, 400);
  if (path === "/me/permissions" && method === "DELETE") {
    revoked.push(token ?? "");
    return json({ success: true });
  }
  if (path === "/me/permissions") return json({ data: [{ permission: "ads_read", status: adsRead ? "granted" : "declined" }, { permission: "public_profile", status: "granted" }] });
  if (path === "/me") return json({ id: USER });
  if (path === "/me/adaccounts") return json({ data: accounts });
  if (path === "/act_111/insights") {
    if (url.searchParams.get("after") === "page2") {
      return json({ data: [{ campaign_id: "2", campaign_name: "Lead magnet", spend: "5.00", date_start: today, publisher_platform: "facebook" }] });
    }
    is("asked by campaign, day by day, by platform, for the last 30 days", [url.searchParams.get("level"), url.searchParams.get("time_increment"), url.searchParams.get("breakdowns"), JSON.parse(url.searchParams.get("time_range") ?? "{}").since], ["campaign", "1", "publisher_platform", daysAgo(29)]);
    return json({
      data: [
        { campaign_id: "1", campaign_name: "October Reel!", spend: "30.00", date_start: today, publisher_platform: "instagram" },
        { campaign_id: "1", campaign_name: "October Reel!", spend: "10.50", date_start: daysAgo(1), publisher_platform: "instagram" },
        { campaign_id: "1", campaign_name: "October Reel!", spend: "0.00", date_start: daysAgo(2), publisher_platform: "threads" },
      ],
      paging: { next: `https://graph.facebook.com/v25.0/act_111/insights?after=page2&access_token=x` },
    });
  }
  return json({ error: { code: 803, message: "unknown" } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();

  part("Marketing API version");
  is("without a setting, use the supported Marketing API default", graphVersion(), "v25.0");
  for (const version of ["", " ", "26.0", "v25", "v25.0/path", "https://example.com"]) {
    process.env.META_GRAPH_VERSION = version;
    is("an invalid version setting uses the supported default: " + JSON.stringify(version), graphVersion(), "v25.0");
  }
  process.env.META_GRAPH_VERSION = " v25.1 ";
  is("a version explicitly configured for a deployment is still honored", graphVersion(), "v25.1");
  delete process.env.META_GRAPH_VERSION;

  part("Meta's rows as lines");
  is("each platform on the channel the numbers count it under", ["instagram", "threads", "facebook", "messenger", "audience_network", undefined].map(platformChannel), ["instagram", "threads", "facebook", "facebook", "facebook", "facebook"]);
  is("in the smallest unit of the account's currency", [minorUnits("12.34", "usd"), minorUnits("500", "jpy"), minorUnits("0", "usd"), minorUnits("x", "usd")], [1234, 500, 0, 0]);
  is("Meta's own utm_source words counted as the channels", ["fb", "ig", "msg", "an"].map(sourceAlias), ["facebook", "instagram", "facebook", "facebook"]);
  const lines = linesFrom([
    { campaign_name: "October Reel!", spend: "3.00", date_start: "2026-10-12", publisher_platform: "instagram" },
    { campaign_name: "October Reel!", spend: "2.00", date_start: "2026-10-12", publisher_platform: "instagram" },
    { campaign_name: "October Reel!", spend: "4.00", date_start: "2026-10-12", publisher_platform: "messenger" },
    { campaign_name: "Nothing", spend: "0.00", date_start: "2026-10-12", publisher_platform: "facebook" },
  ], "usd");
  is("added up by day, channel and campaign, nothing spent left out", lines.map((l) => [l.channel, l.campaign, l.cents, l.from, l.to, l.source]), [
    ["facebook", "octoberreel", 400, "2026-10-12", "2026-10-12", "meta"],
    ["instagram", "octoberreel", 500, "2026-10-12", "2026-10-12", "meta"],
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

  part("A read replaces its days and keeps the days before, a week to a line");
  const day = (d: string, cents: number) => linesFrom([{ campaign_name: "Reel", spend: String(cents / 100), date_start: d, publisher_platform: "instagram" }], "usd")[0];
  // 2026-09-07 is a Monday: three days of it, then a day in the window that a new read replaces.
  const kept = [day("2026-09-07", 100), day("2026-09-08", 200), day("2026-09-09", 300), day("2026-10-01", 999)];
  const merged = mergeLines(kept, [day("2026-10-01", 500)], "2026-09-14", "2026-10-13");
  is("the week before is one line over the days it had, the day read again is Meta's new figure", merged.map((l) => [l.from, l.to, l.cents]), [["2026-09-07", "2026-09-09", 600], ["2026-10-01", "2026-10-01", 500]]);
  is("and the week's money is all there over its days", spendWithin(merged[0], "2026-09-01", "2026-09-30"), 600);
  is("nothing older than 400 days is kept", mergeLines([day("2025-01-01", 100)], [], "2026-09-14", "2026-10-13").length, 0);
  is("merging again changes nothing", mergeLines(merged, [day("2026-10-01", 500)], "2026-09-14", "2026-10-13"), merged);
  const typedIg = { id: "abcdef01", channel: "instagram", campaign: "", cents: 1000, from: "2026-10-01", to: "2026-10-01" };
  const typedPod = { id: "abcdef02", channel: "podcast", campaign: "", cents: 1000, from: "2026-10-01", to: "2026-10-01" };
  is("a typed line on a channel and day Meta read is pointed out; another channel is not", typedOverlap([typedIg, typedPod], merged).map((l) => l.id), ["abcdef01"]);

  part("Which account is read without asking");
  is("the only one, or the only active one in the store's currency", [
    accountToUse([{ id: "act_1", name: "", currency: "eur" }], "usd"),
    accountToUse([{ id: "act_1", name: "", currency: "eur" }, { id: "act_2", name: "", currency: "usd", active: true }], "usd"),
    accountToUse([{ id: "act_1", name: "", currency: "usd" }, { id: "act_2", name: "", currency: "usd" }], "usd"),
  ], ["act_1", "act_2", ""]);

  part("Connecting");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  is("before, the studio offers it and nothing is read", [(await metaView(statsId, store.currency))?.connected, (await readSpends(statsId)).length], [false, 0]);
  const redirect = "https://marktmorgen.com/api/integrations/meta/callback";
  const start = new URL(await beginMeta({ statsId, sid: store.sid, sessionCookie: "session-a", email: "Owner@example.com", redirect }));
  is("Meta's page, asked for ads_read and nothing else", [start.hostname, start.pathname, start.searchParams.get("scope"), start.searchParams.get("client_id"), start.searchParams.get("redirect_uri")], ["www.facebook.com", "/v25.0/dialog/oauth", "ads_read", "123456789012345", redirect]);
  const state = start.searchParams.get("state") ?? "";
  is("another session cannot take it", await takeMeta(state, { sessionCookie: "session-b", email: "owner@example.com" }), null);
  const other = new URL(await beginMeta({ statsId, sid: store.sid, sessionCookie: "session-a", email: "owner@example.com", redirect })).searchParams.get("state") ?? "";
  const taken = await takeMeta(other, { sessionCookie: "session-a", email: "owner@example.com" });
  is("the right session takes it once", [taken?.statsId, (await takeMeta(other, { sessionCookie: "session-a", email: "owner@example.com" })) === null], [statsId, true]);
  is("a code Meta refuses keeps nothing", (await finishMeta({ statsId, sid: store.sid, code: "bad-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency })).ok, false);
  adsRead = false;
  const declined = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  is("without ads_read granted, it is given back and nothing kept", [declined.ok ? "" : declined.error, revoked.length, (await metaView(statsId, store.currency))?.connected], ["permission", 1, false]);
  adsRead = true;
  const connected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  if (!connected.ok) throw new Error(`not connected: ${connected.error}`);
  is("one account: read without asking", connected.account?.name, "Harbor Ads");
  const [rawConn] = await redis.pipeline([["GET", `nl:metaads:conn:${statsId}`]]);
  is("the token is kept sealed, never in the clear", [String(rawConn).includes("EAAlong"), /"token":"s1\./.test(String(rawConn))], [false, true]);
  is("it ends when Meta's token ends, about 60 days on", Math.round(((connected.view.expires * 1000) - Date.now()) / 86_400_000), 60);

  part("Read into the numbers");
  is("read", await readMetaSpend(statsId, store.currency), "read");

  part("The kept Meta lines read in another shape: nothing written over them");
  const [keptRaw] = await redis.pipeline([["GET", linesKey(statsId)]]);
  const keptLines = JSON.parse(String(keptRaw)) as Record<string, unknown>[];
  const old = { ...keptLines[0], from: daysAgo(80), to: daysAgo(80), cents: 777 };
  await redis.pipeline([["SET", linesKey(statsId), JSON.stringify([old, ...keptLines]), "EX", 86_400 * 400]]);
  const pipeline = redis.pipeline.bind(redis);
  type Batch = (string | number)[][];
  for (const [label, reply] of [["no reply", []], ["a number", [7]], ["an object", [{}]]] as [string, unknown[]][]) {
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.length === 1 && b[0][0] === "GET" && b[0][1] === linesKey(statsId) ? reply : real;
    }) as typeof redis.pipeline;
    try {
      await readMetaSpend(statsId, store.currency).catch(() => "threw");
    } finally {
      redis.pipeline = pipeline;
    }
    const [after] = await pipeline([["GET", linesKey(statsId)]]);
    is(`${label}: the day outside the window is still kept`, (JSON.parse(String(after)) as { cents: number }[]).some((l) => l.cents === 777), true);
  }

  part("Typed lines over the cap, read in another shape: none deleted");
  for (let i = 0; i < MAX_SPEND_ENTRIES; i += 1) await addSpend(statsId, { channel: "podcast", cents: 100 + i, from: daysAgo(i % 300), to: daysAgo(i % 300) });
  const [before] = await pipeline([["HLEN", `nl:stats:${statsId}:spend`]]);
  redis.pipeline = (async (b: Batch) => {
    const real = await pipeline(b);
    // The typed lines' HGETALL answered as a number, in whichever request it is sent.
    return b.map((c, i) => (c[0] === "HGETALL" && c[1] === `nl:stats:${statsId}:spend` ? 7 : real[i]));
  }) as typeof redis.pipeline;
  try {
    await addSpend(statsId, { channel: "podcast", cents: 999, from: today, to: today }).catch(() => null);
  } finally {
    redis.pipeline = pipeline;
  }
  const [afterAdd] = await pipeline([["HLEN", `nl:stats:${statsId}:spend`]]);
  is("no typed line is deleted on an unread list", Number(afterAdd) >= Number(before), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
