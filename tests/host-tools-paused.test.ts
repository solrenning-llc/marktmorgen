/**
 * 232 [CA1] unit 4b4a: while a store's plan renewal is unpaid (or a payment
 * for its plan is disputed), the tools on accounts already connected that
 * reach a provider for the creator wait too: a test meeting made or moved, a
 * team host's calendar read again, its calendars listed or chosen, an iCal
 * address read, and Google or iCal picked as the source of busy times. They
 * are refused before any provider call, with their own sentence. Taking
 * something away stays open (disconnecting, removing a calendar address,
 * choosing no source, deleting a test meeting), and everything works again
 * once paid (lib/integration-pause.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { beginConsent, finishConsent, takeConsent } from "@/lib/meet-connect";
import { hostId } from "@/lib/host-claims";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { POST as hostCalendar } from "@/app/api/store/host-calendar/route";
import { POST as meetings } from "@/app/api/integrations/meetings/route";
import { hostCalendarView } from "@/lib/host-calendar";
import { claimHandle, ensureStatsId, recordPlanDispute, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { CALENDAR_LIST_PAUSED, MEETING_TEST_PAUSED_WORDS, TOOLS_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";
process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
process.env.ZOOM_LIVE = "1";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "host-tools-paused@example.com";
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

function idToken(email: string): string {
  const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part64({ alg: "none" })}.${part64({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

/** Every request that left this process: none may leave for a provider while paused. */
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  asked.push(`${url.hostname}${url.pathname}`);
  if (url.pathname === "/google/token") {
    return answer({ access_token: "at-host", refresh_token: "rt-host", expires_in: 3600, scope: GOOGLE_HOST_SCOPES.join(" "), id_token: idToken(OWNER) });
  }
  if (url.pathname === "/google/calendar/v3/users/me/calendarList") {
    return answer({ items: [{ id: OWNER, summary: "Mine", primary: true, accessRole: "owner" }] });
  }
  if (url.pathname === "/google/calendar/v3/freeBusy") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { items?: { id: string }[] };
    return answer({ kind: "calendar#freeBusy", calendars: Object.fromEntries((body.items ?? []).map((i) => [i.id, { busy: [] }])) });
  }
  return answer({ error: "not in this test" }, 404);
}) as typeof fetch;

/** The paused store's small daily studio figure (ESSENTIAL_PER_DAY) is a real bound; each part starts afresh. */
async function freshDay(): Promise<void> {
  const [scan] = (await redis.pipeline([["SCAN", "0", "MATCH", "*studio-essential*"]])) as [[string, string[]]];
  if (scan[1].length) await redis.pipeline([["DEL", ...scan[1]]]);
}

const leftForProvider = (from: number) => asked.slice(from).filter((a) => !a.startsWith("api.resend.com"));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "host-tools-paused-shop", "Host Tools Paused Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_HostToolsPause", subscriptionId: "sub_HostToolsPause", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const pin = `store=${store.sid}`;
  const send = (path: string, body: Record<string, unknown>) =>
    new NextRequest(`${ORIGIN}${path}?${pin}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const cal = async (body: Record<string, unknown>) => {
    const res = await hostCalendar(send("/api/store/host-calendar", { tz: "UTC", ...body }));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; message?: string; view?: { calendars: unknown; calendarsError: string } } };
  };
  const meet = async (body: Record<string, unknown>) => {
    const res = await meetings(send("/api/integrations/meetings", body));
    return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; message?: string } };
  };

  part("Paid: the host connects Google Calendar and the tools reach Google");
  const url = await beginConsent("google", { statsId: store.statsId!, sid: store.sid!, sessionCookie: session, email: OWNER, host: hostId(OWNER), scopes: GOOGLE_HOST_SCOPES });
  const taken = await takeConsent("google", new URL(url).searchParams.get("state") ?? "", { sessionCookie: session, email: OWNER });
  const connected = taken ? await finishConsent("google", { statsId: taken.statsId, code: "good", verifier: taken.verifier, by: OWNER, owner: { email: store.email, handle: store.handle }, host: taken.host }) : { ok: false };
  is("the host's Google Calendar is connected", connected.ok, true);
  let from = asked.length;
  const paidView = await hostCalendarView(store, OWNER, "UTC");
  is("the page lists the host's calendars from Google", [Array.isArray(paidView.calendars), leftForProvider(from).some((a) => a.endsWith("/calendarList"))], [true, true]);
  const chose = await cal({ action: "calendars", read: [], write: "" });
  is("choosing calendars goes through", [chose.status, chose.body.ok], [200, true]);
  is("picking Google as the source goes through", (await cal({ action: "source", source: "google" })).status, 200);
  const badIcs = await cal({ action: "ics-add", url: "not an address" });
  is("an iCal address is judged as before (not refused for a pause)", [badIcs.status, badIcs.body.error], [400, "ics"]);
  // The store's own Google meetings account, so a test meeting really reaches Google when paid.
  const storeUrl = await beginConsent("google", { statsId: store.statsId!, sid: store.sid!, sessionCookie: session, email: OWNER });
  const storeTaken = await takeConsent("google", new URL(storeUrl).searchParams.get("state") ?? "", { sessionCookie: session, email: OWNER });
  const storeConnected = storeTaken ? await finishConsent("google", { statsId: storeTaken.statsId, code: "good", verifier: storeTaken.verifier, by: OWNER, owner: { email: store.email, handle: store.handle } }) : { ok: false };
  is("the store's Google meetings account is connected", storeConnected.ok, true);
  from = asked.length;
  await meet({ action: "test", provider: "google" });
  is("a test meeting reaches Google when paid", leftForProvider(from).some((a) => a.includes("/calendars/")), true);
  const test = await meet({ action: "test", provider: "zoom" });
  is("a test meeting goes on to the provider's rules (Zoom is not connected here)", [test.status, test.body.error], [400, "not_connected"]);

  part("Renewal unpaid: the tools wait, before any provider call");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  store = (await storeForEmail(OWNER))!;
  is("the store's costs are paused", integrationPauseWord(store), "paused_unpaid");
  from = asked.length;
  for (const action of ["check", "calendars", "ics-add"] as const) {
    const r = await cal({ action, read: [], write: "", url: "https://calendar.example.com/private.ics" });
    is(`${action} is refused with the sentence`, [r.status, r.body.error, r.body.message], [409, "paused_unpaid", TOOLS_PAUSED_WORDS.paused_unpaid]);
  }
  for (const source of ["google", "ics"]) {
    const r = await cal({ action: "source", source });
    is(`picking ${source} as the source is refused`, [r.status, r.body.error], [409, "paused_unpaid"]);
  }
  const testPaused = await meet({ action: "test", provider: "google" });
  is("a test meeting is refused with its sentence", [testPaused.status, testPaused.body.error, testPaused.body.message], [409, "paused_unpaid", MEETING_TEST_PAUSED_WORDS.paused_unpaid]);
  is("moving it is refused", (await meet({ action: "movetest", provider: "google" })).status, 409);
  const view = await hostCalendarView(store, OWNER, "UTC");
  is("the page does not read Google's list and says why", [view.calendars, view.calendarsError], [null, CALENDAR_LIST_PAUSED]);
  is("no request left for any provider while paused", leftForProvider(from), []);

  part("Taking something away stays open");
  await freshDay();
  const none = await cal({ action: "source", source: "none" });
  is("choosing no source works", [none.status, none.body.ok], [200, true]);
  is("removing a calendar address works", (await cal({ action: "ics-remove" })).status, 200);
  is("deleting a test meeting works", (await meet({ action: "untest", provider: "google" })).status, 200);
  const off = await cal({ action: "disconnect" });
  is("disconnecting the host's Google Calendar works", [off.status, off.body.ok], [200, true]);

  part("Disputed: the dispute's sentence");
  await freshDay();
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  const now = Math.floor(Date.now() / 1000);
  is("the dispute is written down", Boolean(await recordPlanDispute(storeRef(store), { id: "du_HostToolsPause1", status: "open", at: now, coversUntil: now + 30 * 86_400 })), true);
  const disputed = await cal({ action: "check" });
  is("a calendar check is refused for the dispute", [disputed.status, disputed.body.message], [409, TOOLS_PAUSED_WORDS.paused_disputed]);
  is("a test meeting too", (await meet({ action: "test", provider: "zoom" })).body.error, "paused_disputed");

  part("Paid again: the tools work again");
  await freshDay();
  is("the dispute won", Boolean(await recordPlanDispute(storeRef(store), { id: "du_HostToolsPause1", status: "won", at: now, coversUntil: now + 30 * 86_400 })), true);
  is("a test meeting goes on to the provider's rules again", (await meet({ action: "test", provider: "zoom" })).body.error, "not_connected");
  is("an iCal address is judged again", (await cal({ action: "ics-add", url: "not an address" })).body.error, "ics");

  part("Unpaid, then paid with no dispute: the tools work again");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  await freshDay();
  is("unpaid again refuses", (await cal({ action: "check" })).status, 409);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  await freshDay();
  is("paid: an iCal address is judged again", (await cal({ action: "ics-add", url: "not an address" })).body.error, "ics");

  part("Words");
  for (const w of ["paused_unpaid", "paused_disputed"] as const) {
    is(`the calendar's ${w} names what stays open on that page`, ["remove your calendar address", "choose no calendar", "disconnect Google Calendar"].every((s) => TOOLS_PAUSED_WORDS[w].includes(s)), true);
    is(`the test meeting's ${w} names what stays open on that page`, ["delete a test meeting", "disconnect the account"].every((s) => MEETING_TEST_PAUSED_WORDS[w].includes(s)), true);
  }
  const card = readFileSync(join(process.cwd(), "components/meeting-connections.tsx"), "utf8");
  is("the meetings card shows the route's own sentence", card.includes("setError(data.message ?? MESSAGES"), true);
  const hostCard = readFileSync(join(process.cwd(), "components/host-calendar.tsx"), "utf8");
  is("the host calendar card shows the route's own sentence", hostCard.includes("data.message ??"), true);
  done();
}

main();
