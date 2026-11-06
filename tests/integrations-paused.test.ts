/**
 * 232 [CA1] unit 4b3: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), a new Zoom, Google Calendar or Meta connection
 * is new work nobody is paying for. Starting one and finishing one are
 * refused before any provider call, Meta's daily read and the account
 * picker's read wait, and disconnecting stays open. A paid store connects as
 * before, and everything starts again once paid (lib/integration-pause.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { finishConnect, startConnect, startHostConnect } from "@/lib/meet-routes";
import { beginConsent } from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { finishMetaConnect, startMeta, stopMeta } from "@/lib/meta-routes";
import { POST as chooseMeta } from "@/app/api/store/meta-ads/route";
import { beginMeta, finishMeta, metaView, readMetaDue, readMetaSpend } from "@/lib/meta-ads";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { costsPaused } from "@/lib/plan-standing";
import { INTEGRATION_PAUSED_WORDS, META_READ_PAUSED, integrationPauseWord } from "@/lib/integration-pause";
import { RENEWAL_PAUSED_WORDS } from "@/lib/renewal-unpaid-words";
import { DISPUTE_PAUSED_WORDS } from "@/lib/plan-dispute-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.GOOGLE_OAUTH_CLIENT_ID = "g-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
process.env.ZOOM_LIVE = "1";
process.env.META_APP_ID = "123456789012345";
process.env.META_APP_SECRET = "meta-app-secret-for-tests-0123456789";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
delete process.env.META_GRAPH_BASE;
delete process.env.META_GRAPH_VERSION;

const OWNER = "integrations-paused@example.com";
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;
const today = new Date().toISOString().slice(0, 10);

/** Every request that left for a provider: none may leave while paused. */
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  asked.push(`${url.hostname}${url.pathname}`);
  if (url.hostname !== "graph.facebook.com") return json({ error: "not in this test" }, 400);
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  if (path === "/oauth/access_token") {
    return url.searchParams.get("grant_type") === "fb_exchange_token" ? json({ access_token: "EAAlong", token_type: "bearer", expires_in: 5_184_000 }) : json({ access_token: "EAAshort" });
  }
  if (path === "/me/permissions" && url.searchParams.get("method") !== "delete") return json({ data: [{ permission: "ads_read", status: "granted" }] });
  if (path === "/me/permissions") return json({ success: true });
  if (path === "/me") return json({ id: "10150000000000001" });
  if (path === "/me/adaccounts") return json({ data: [{ id: "act_111", account_id: "111", name: "Harbor Ads", currency: "USD", account_status: 1 }] });
  if (path === "/act_111/insights") return json({ data: [{ campaign_id: "1", campaign_name: "Reel", spend: "3.00", date_start: today, publisher_platform: "instagram" }] });
  return json({ success: true });
}) as typeof fetch;

const post = (path: string, cookie: string) => new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie } });
const get = (path: string, cookie: string) => new NextRequest(`${ORIGIN}${path}`, { headers: { host: HOST, cookie } });
const word = (res: Response, name: string) => new URL(res.headers.get("location") ?? "https://none.invalid/").searchParams.get(name);
const where = (res: Response) => new URL(res.headers.get("location") ?? "https://none.invalid/").hostname;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "integrations-paused-shop", "Integrations Paused Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_IntegrationsPause", subscriptionId: "sub_IntegrationsPause", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const pin = `store=${store.sid}`;
  const redirect = `${ORIGIN}/api/integrations/meta/callback`;

  const googleReturn = async (code = "synthetic-code", host = false) => {
    const consent = await beginConsent("google", { statsId, sid: store.sid!, sessionCookie: session, email: OWNER, ...(host ? { host: hostId(OWNER), scopes: GOOGLE_HOST_SCOPES } : {}) });
    const q = new URLSearchParams({ state: new URL(consent).searchParams.get("state") ?? "" });
    if (code) q.set("code", code); else q.set("error", "access_denied");
    return finishConnect(get(`/api/integrations/google/callback?${q}`, cookie), "google");
  };
  const metaReturn = async (decline = false) => {
    const consent = await beginMeta({ statsId, sid: store.sid!, sessionCookie: session, email: OWNER, redirect });
    const q = new URLSearchParams({ state: new URL(consent).searchParams.get("state") ?? "" });
    q.set(decline ? "error" : "code", decline ? "access_denied" : "good-code");
    return finishMetaConnect(get(`/api/integrations/meta/callback?${q}`, cookie));
  };

  part("Paid: starting a connection goes to the provider, as before");
  is("the store's costs run", [costsPaused(store), integrationPauseWord(store)], [false, null]);
  is("Google Calendar's start leaves for Google", where(await startConnect(post(`/api/integrations/google/start?${pin}`, cookie), "google")), "accounts.google.com");
  is("Zoom's start leaves for Zoom", where(await startConnect(post(`/api/integrations/zoom/start?${pin}`, cookie), "zoom")), "zoom.us");
  is("Meta's start leaves for Meta", where(await startMeta(post(`/api/integrations/meta/start?${pin}`, cookie))), "www.facebook.com");
  const connected = await finishMeta({ statsId, sid: store.sid!, code: "good-code", redirect, by: OWNER, owner: { email: store.email, handle: store.handle }, currency: store.currency });
  is("Meta connected while paid", connected.ok, true);

  part("Renewal unpaid: no new connection, no provider call");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  is("the store's costs are paused", [costsPaused(store), integrationPauseWord(store)], [true, "paused_unpaid"]);
  const before = asked.length;
  const zoomStart = await startConnect(post(`/api/integrations/zoom/start?${pin}`, cookie), "zoom");
  is("Zoom's start stays at the studio with the word", [where(zoomStart), word(zoomStart, "meet"), word(zoomStart, "p")], [HOST, "paused_unpaid", "zoom"]);
  const googleStart = await startConnect(post(`/api/integrations/google/start?${pin}`, cookie), "google");
  is("Google Calendar's start too", [where(googleStart), word(googleStart, "meet")], [HOST, "paused_unpaid"]);
  const hostStart = await startHostConnect(post(`/api/integrations/google/start?for=host&${pin}`, cookie));
  is("a team host's own calendar too", [where(hostStart), word(hostStart, "cal")], [HOST, "paused_unpaid"]);
  const metaStart = await startMeta(post(`/api/integrations/meta/start?${pin}`, cookie));
  is("Meta's start too", [where(metaStart), word(metaStart, "metaads")], [HOST, "paused_unpaid"]);
  is("a consent started before the pause is not exchanged on return (Google)", word(await googleReturn(), "meet"), "paused_unpaid");
  is("nor a host's own (Google)", word(await googleReturn("synthetic-code", true), "cal"), "paused_unpaid");
  is("nor Meta's", word(await metaReturn(), "metaads"), "paused_unpaid");
  is("canceling on the provider's page still says nothing was connected", [word(await googleReturn(""), "meet"), word(await metaReturn(true), "metaads")], ["declined", "declined"]);
  is("Meta's read waits", await readMetaSpend(statsId, store.currency), "paused");
  const picked = await chooseMeta(new NextRequest(`${ORIGIN}/api/store/meta-ads?${pin}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "account", id: "act_111" }) }));
  const pickedBody = (await picked.json()) as { ok?: boolean; meta?: { readPaused?: boolean } };
  is("the account picker saves the choice and says its read waits", [picked.status, pickedBody.ok, pickedBody.meta?.readPaused], [200, true, true]);
  await redis.pipeline([["DEL", `nl:metaads:read:${statsId}`]]);
  const due = await readMetaDue(Date.now() + 10_000, storeForId);
  is("the daily pass skips it", [due.read, due.skipped], [0, 1]);
  is("no request left for any provider while paused", asked.slice(before), []);
  const stopped = await stopMeta(post(`/api/integrations/meta/disconnect?${pin}`, cookie));
  // The route's after() (the owner's notice) needs a request scope this test has not, so it answers
  // "error" here after disconnecting; what counts is that the pause did not stop it.
  is("disconnecting stays open: the connection is gone and the pause's word is not the answer", [String(word(stopped, "metaads")).startsWith("paused"), (await metaView(statsId, store.currency))?.connected], [false, false]);

  part("Disputed: the same refusals, with the dispute's word");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  is("the dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_IntegrationsPause1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  is("paused for the dispute", integrationPauseWord(store), "paused_disputed");
  const beforeDispute = asked.length;
  is("Zoom refused", word(await startConnect(post(`/api/integrations/zoom/start?${pin}`, cookie), "zoom"), "meet"), "paused_disputed");
  is("Meta refused", word(await startMeta(post(`/api/integrations/meta/start?${pin}`, cookie)), "metaads"), "paused_disputed");
  is("Google's return refused", word(await googleReturn(), "meet"), "paused_disputed");
  is("still no provider request", asked.slice(beforeDispute), []);

  part("Paid again: everything starts again");
  is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_IntegrationsPause1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
  store = (await storeForEmail(OWNER))!;
  is("costs run again", integrationPauseWord(store), null);
  is("Meta's start leaves for Meta again", where(await startMeta(post(`/api/integrations/meta/start?${pin}`, cookie))), "www.facebook.com");
  const beforeReturn = asked.length;
  const back = await metaReturn();
  // As above, after() needs a request scope; the exchange with Meta happening is what shows the pause lifted.
  is("and its return goes on to exchange the code with Meta", [String(word(back, "metaads")).startsWith("paused"), asked.slice(beforeReturn).some((a) => a.endsWith("/oauth/access_token")), (await metaView(statsId, store.currency))?.connected], [false, true, true]);

  part("Words");
  const editor = readFileSync(join(process.cwd(), "components/ad-spend-editor.tsx"), "utf8");
  is("the ad-spend card's sentence ends as META_READ_PAUSED does", editor.includes(META_READ_PAUSED.replace("Reading your Meta ad spend also waits, and starts again", "starts again")), true);
  is("each word has its sentence, naming what stays", [INTEGRATION_PAUSED_WORDS.paused_unpaid.includes("disconnect"), INTEGRATION_PAUSED_WORDS.paused_disputed.includes("disconnect")], [true, true]);
  is("the studio notice, the email and the Terms name the connections (renewal and dispute)", [RENEWAL_PAUSED_WORDS.includes("new connections to Zoom, Google Calendar and Meta"), DISPUTE_PAUSED_WORDS.includes("new connections to Zoom, Google Calendar and Meta")], [true, true]);
  done();
}

main();
