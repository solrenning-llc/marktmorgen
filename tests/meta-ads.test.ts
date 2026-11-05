/**
 * What a store's Meta ad account spent, read into its numbers
 * (lib/meta-ads.ts, lib/meta-ads-rules.ts, lib/ad-spend.ts; added 13 October
 * 2026). Checked:
 *
 *   - Meta's rows become one-day lines on the channel the numbers count
 *     (Instagram, Threads, Facebook for the rest), the campaign as a
 *     utm_campaign is counted, in the smallest unit of the currency;
 *   - a read replaces the days it read, keeps the days before a week to a
 *     line, and the typed lines that may repeat it are pointed out;
 *   - connecting asks for ads_read only, the state is once only and for that
 *     session, the token is kept sealed and every call carries
 *     appsecret_proof; one account, or one in the store's currency, is read
 *     without asking;
 *   - the lines come back with the typed ones, marked as Meta's, and only
 *     while connected; an account in another currency is not read;
 *   - a token Meta refuses marks it broken and the owner is told once;
 *   - disconnecting, or Meta's signed notice, gives it back and forgets it;
 *   - the daily pass reads each store once a day.
 */
import { createHmac } from "node:crypto";
import { linesFrom, mergeLines, minorUnits, platformChannel } from "@/lib/meta-ads-rules";
import { spendWithin, typedOverlap } from "@/lib/ad-spend-rules";
import {
  accountToUse,
  beginMeta,
  chooseAccount,
  disconnectMeta,
  finishMeta,
  forgetMetaUser,
  graphVersion,
  linesKey,
  metaView,
  readMetaDue,
  readMetaSpend,
  signedUser,
  takeMeta,
} from "@/lib/meta-ads";
import { addSpend, readSpends } from "@/lib/ad-spend";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeForId } from "@/lib/store";
import { sourceAlias } from "@/lib/source-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { startMeta, finishMetaConnect } from "@/lib/meta-routes";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";

const SECRET = "meta-app-secret-for-tests-0123456789";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = SECRET;
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const USER = "10150000000000001";
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

let accounts: Record<string, unknown>[] = [{ id: "act_111", account_id: "111", name: "Harbor Ads", currency: "USD", account_status: 1 }];
let refuse = false;
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
  is("every call to Meta carries appsecret_proof", proofs.length > 0 && proofs.every(Boolean), true);
  is("Meta's next page is followed", asked.filter((a) => a === "GET /act_111/insights").length, 2);
  await addSpend(statsId, { channel: "podcast", cents: 2000, from: today, to: today });
  const spends = await readSpends(statsId);
  is("Meta's lines come with the typed ones, marked as Meta's", spends.map((s) => [s.source ?? "typed", s.channel, s.campaign, s.cents]).sort(), [
    ["meta", "facebook", "leadmagnet", 500],
    ["meta", "instagram", "octoberreel", 1050],
    ["meta", "instagram", "octoberreel", 3000],
    ["typed", "podcast", "", 2000],
  ]);
  const view = (await metaView(statsId, store.currency))!;
  is("the studio says when and how much", [view.read?.day, view.read?.cents, view.read?.campaigns, view.read?.problem], [today, 4550, 2, ""]);

  part("Another currency is not read");
  accounts = [...accounts, { id: "act_222", name: "Euro Ads", currency: "EUR", account_status: 1 }];
  const again = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  is("the account in the store's currency is still the one read", again.ok ? again.account?.id : "", "act_111");
  is("choosing one that is not listed does nothing", await chooseAccount(statsId, "act_999"), false);
  await chooseAccount(statsId, "act_222");
  is("in EUR for a store in USD: not read, and the lines of the other account are gone", [await readMetaSpend(statsId, store.currency), (await readSpends(statsId)).filter((s) => s.source === "meta").length, (await metaView(statsId, store.currency))?.read?.problem], ["currency", 0, "currency"]);
  await chooseAccount(statsId, "act_111");

  part("A token Meta refuses");
  let told = 0;
  refuse = true;
  is("marks it broken", await readMetaSpend(statsId, store.currency, Date.now(), async () => { told += 1; }), "broken");
  await readMetaSpend(statsId, store.currency, Date.now(), async () => { told += 1; });
  is("the owner is told once, and the studio says why", [told, Boolean((await metaView(statsId, store.currency))?.broken)], [1, true]);
  refuse = false;

  part("The daily pass");
  const reconnected = await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  is("connecting again works again", reconnected.ok && !reconnected.view.broken, true);
  const first = await readMetaDue(Date.now() + 10_000, storeForId);
  const second = await readMetaDue(Date.now() + 10_000, storeForId);
  is("each store read once a day", [first.read, second.read], [1, 0]);

  part("Funded new Meta connection phases refuse before provider work");
  await claimHandle("funded-meta@example.com", "funded-meta-shop", "Funded Meta Shop", "");
  await ensureStatsId("funded-meta@example.com");
  await setSubscription("funded-meta@example.com", { customerId: "cus_MetaFunded001", subscriptionId: "sub_MetaFunded001", active: true, period: { ...paidPeriod(), funded: true } });
  const funded = (await storeForEmail("funded-meta@example.com"))!;
  const session = await openSession("funded-meta@example.com");
  const origin = "https://marktmorgen.com";
  const cookie = `${SESSION_COOKIE}=${session}`;
  const beforeMetaRequests = asked.length;
  const beforeMetaUnits = await allowanceUsed(funded, "integration");
  const started = await startMeta(new NextRequest(`${origin}/api/integrations/meta/start?store=${funded.sid}`, { method: "POST", headers: { host: "marktmorgen.com", origin, cookie } }));
  const destination = new URL(started.headers.get("location") ?? "https://none.invalid/");
  is("a new start stays at the studio", [started.status, destination.hostname, destination.searchParams.get("metaads")], [303, "marktmorgen.com", "funding"]);
  const returnMeta = async (decline = false) => {
    // Synthetic state models a consent started before its funding proof became unavailable.
    const consent = await beginMeta({ statsId: funded.statsId!, sid: funded.sid, sessionCookie: session, email: "funded-meta@example.com", redirect: `${origin}/api/integrations/meta/callback` });
    const query = new URLSearchParams({ state: new URL(consent).searchParams.get("state") ?? "" });
    query.set(decline ? "error" : "code", decline ? "access_denied" : "synthetic-code");
    return finishMetaConnect(new NextRequest(`${origin}/api/integrations/meta/callback?${query}`, { headers: { host: "marktmorgen.com", cookie } }));
  };
  const returned = await returnMeta();
  is("valid new callback state cannot exchange credentials without funding", [returned.status, new URL(returned.headers.get("location")!).searchParams.get("metaads")], [303, "funding"]);
  const financialDecline = await returnMeta(true);
  is("canceling remains available", new URL(financialDecline.headers.get("location")!).searchParams.get("metaads"), "declined");
  is("no provider request or extra integration allowance", [asked.length, await allowanceUsed(funded, "integration")], [beforeMetaRequests, beforeMetaUnits]);

  part("Marked paid Meta spend reads require the current store cohort before new work");
  await finishMeta({ statsId: funded.statsId!, sid: funded.sid, code: "good-code", redirect, by: "funded-meta@example.com", owner: { email: funded.email, handle: funded.handle }, currency: funded.currency });
  const keptConnection = (await metaView(funded.statsId!, funded.currency))!;
  for (const tier of ["creator", "pro", "scale"] as const) for (const cycle of ["month", "year"] as const) {
    await setSubscription("funded-meta@example.com", { customerId: "cus_MetaFunded001", subscriptionId: "sub_MetaFunded001", active: true, tier, cycle, trialEnds: 0, period: { ...paidPeriod(Date.now(), { behind: 10, ahead: cycle === "year" ? 355 : 20 }), funded: true } });
    const beforeProvider = asked.length;
    is("fresh paid read refuses without a cohort " + tier + " " + cycle, await readMetaSpend(funded.statsId!, funded.currency), "busy");
    is("no provider request or spend/read record " + tier + " " + cycle, [asked.length, await readSpends(funded.statsId!), (await metaView(funded.statsId!, funded.currency))?.read], [beforeProvider, [], keptConnection.read]);
  }
  const beforeDailyProvider = asked.length;
  const dueWithoutFunds = await readMetaDue(Date.now() + 10_000, storeForId);
  is("the actual daily pass skips the unfunded new read", [dueWithoutFunds.read, dueWithoutFunds.skipped, asked.length], [0, 1, beforeDailyProvider]);
  is("connection and cached view remain readable", (await metaView(funded.statsId!, funded.currency))?.connected, true);
  is("retained disconnect still works without a cohort", Boolean(await disconnectMeta(funded.statsId!)), true);

  part("Meta's notice, and disconnecting");
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: USER, issued_at: 1 })).toString("base64url");
  const signed = `${createHmac("sha256", SECRET).update(payload).digest("base64url")}.${payload}`;
  is("a notice signed with the app's secret names the user; another does not", [signedUser(signed), signedUser(`${createHmac("sha256", "other").update(payload).digest("base64url")}.${payload}`), signedUser("x.y")], [USER, null, null]);
  const forgot = await forgetMetaUser(USER);
  is("every store that user connected forgets it, and what was read", [forgot.map((f) => f.statsId), (await metaView(statsId, store.currency))?.connected, (await readSpends(statsId)).filter((s) => s.source === "meta").length, (await redis.pipeline([["EXISTS", linesKey(statsId)]]))[0]], [[statsId], false, 0, 0]);
  await finishMeta({ statsId, sid: store.sid, code: "good-code", redirect, by: "owner@example.com", owner: { email: store.email, handle: store.handle }, currency: store.currency });
  await readMetaSpend(statsId, store.currency);
  const before = revoked.length;
  const gone = await disconnectMeta(statsId);
  is("disconnecting gives it back to Meta and deletes what was read; the typed line stays", [gone && gone.id, revoked.length - before, (await readSpends(statsId)).map((s) => s.source ?? "typed")], ["act_111", 1, ["typed"]]);
  is("disconnecting what is not connected says so", await disconnectMeta(statsId), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
