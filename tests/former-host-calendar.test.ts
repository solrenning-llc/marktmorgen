/**
 * A team booking's event on the Google Calendar of a host who has left the
 * store's team (9 November 2026).
 *
 * A team booking whose host connected their own Google Calendar is written
 * there (lib/host-calendar.ts hostWriteTarget), with a Meet link and the buyer
 * on the guest list. The event was made, moved and retried on that host's own
 * connection whoever that host was by then: somebody taken off the team after
 * the time was held still had the buyer's address and every new time put on
 * their calendar. The emails already leave them out (creatorSideOf, the unit
 * below this one).
 *
 * Checked against the real code (lib/calls.ts, lib/meet-links.ts,
 * lib/meet-connect.ts), with an in-memory Redis and stand-ins for Google,
 * Stripe and Resend. Each request to Google is told apart by the token it
 * carries: the host's own ("at-maya@example.com") or the store's.
 *
 *   - removed before the confirmation: nothing is made on the host's
 *     calendar; the store's own Google connection makes the meeting when the
 *     call is set to Google, and the call's room is given when it is not;
 *   - removed before a move: the host's event is not moved, it is deleted
 *     from their calendar, and the meeting at the new time is the store's,
 *     whose link the buyer's "Moved" email carries;
 *   - a team that cannot be read (rule 24): the owner only, never the host;
 *   - the five-minute job never makes or moves anything on the calendar of a
 *     host who has left;
 *   - a host still on the team: written, moved and kept on their calendar as
 *     before.
 *
 * Added after the pre-review of 7d5c0179f9 (the commit before said more than
 * it did: nothing was deleted when the host left and the booking did not
 * move, and a move the job still had to make was given up with the event
 * left there):
 *
 *   - removed, with no move at all: the five-minute job finds the booking
 *     (once an hour a store), deletes the event from her calendar, gives the
 *     booking the store's own meeting or the call's room, and emails the
 *     buyer the new link; a team that cannot be read changes nothing;
 *   - a move the job still had to make on her calendar: the event is
 *     deleted there instead, and the buyer is emailed the new link;
 *   - a move that leaves the booking with no link at all: the owner's
 *     "Moved" email asks them to send one, as the confirmation does;
 *   - a collective call's other hosts are checked with one read of the team.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { putMember, removeMember } from "@/lib/team";
import { writeTeam } from "@/lib/team-booking";
import { hostId } from "@/lib/host-claims";
import { beginConsent, finishConsent, takeConsent } from "@/lib/meet-connect";
import { GOOGLE_HOST_SCOPES } from "@/lib/meet-providers";
import { hostSync, setHostCalendars, setHostSource } from "@/lib/host-calendar";
import { retryRecord } from "@/lib/meet-links";
import { syncMeetings } from "@/lib/call-meetings";
import { type MeetRecord, callScope, readRecord, writeRecord } from "@/lib/meet-records";
import { roomOf } from "@/lib/call-rooms";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const ORIGIN = "https://marktmorgen.com";
const MAYA = "maya@example.com";
const MAYA_TOKEN = `at-${MAYA}`;
const HOST_CALENDAR = "team@group.calendar.google.com";

/** Each Meet link names whose connection made it: the host's or the store's. */
const LINKS: Record<string, string> = { [MAYA_TOKEN]: "https://meet.google.com/aaa-bbbb-ccc" };
const linkFor = (token: string) => LINKS[token] ?? "https://meet.google.com/ooo-pppp-qqq";
const HOST_LINK = LINKS[MAYA_TOKEN];
const STORE_LINK = linkFor("store");

const google: { method: string; path: string; token: string; body: string }[] = [];
const sent: { to: string; subject: string; text: string }[] = [];
let sessions = 0;
/** Each checkout's metadata, and the ones paid, by their buyer's address (Stripe lists them as paid). */
const checkouts = new Map<string, Record<string, string>>();
const paidBy = new Map<string, string>();
/** Google answers every write with a server error while this is on. */
let googleDown = false;

function idToken(email: string): string {
  const piece = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${piece({ alg: "none" })}.${piece({ iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com", exp: Math.floor(Date.now() / 1000) + 3600, sub: `sub-${email}`, email, email_verified: true })}.sig`;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: String([body.to].flat()[0]).toLowerCase(), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return answer({ id: `email_${sent.length}` });
  }
  if (url.hostname === "127.0.0.1") {
    const path = url.pathname;
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    google.push({ method, path: path + url.search, token, body: String(init?.body ?? "") });
    if (path === "/google/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const who = form.get("code") ?? "x@example.com";
      return answer({ access_token: `at-${who}`, refresh_token: `rt-${who}`, expires_in: 3600, scope: GOOGLE_HOST_SCOPES.join(" "), id_token: idToken(who) });
    }
    if (path === "/google/calendar/v3/freeBusy") {
      const body = JSON.parse(String(init?.body)) as { items: { id: string }[] };
      return answer({ kind: "calendar#freeBusy", calendars: Object.fromEntries(body.items.map((i) => [i.id, { busy: [] }])) });
    }
    if (path === "/google/calendar/v3/users/me/calendarList") {
      return answer({ items: [{ id: MAYA, summary: "Maya", primary: true, accessRole: "owner" }, { id: HOST_CALENDAR, summary: "Team calls", accessRole: "writer" }] });
    }
    const event = /^\/google\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/?]+))?$/.exec(path);
    if (event) {
      if (googleDown && method !== "GET") return answer({ error: { code: 503, message: "backend error" } }, 503);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as { id: string };
        return answer({ id: body.id, status: "confirmed", hangoutLink: linkFor(token) });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return answer({ id: event[2], status: "confirmed", hangoutLink: linkFor(token), attendees: [] });
    }
    return answer({ error: "no stand-in" }, 404);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_hostcal${String(sessions).padStart(11, "0")}`;
    const form = new URLSearchParams(String(init?.body ?? ""));
    const metadata: Record<string, string> = {};
    for (const [key, value] of form) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) metadata[m[1]] = value;
    }
    checkouts.set(id, metadata);
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") {
    const data = [...paidBy].map(([id, email]) => ({ id, status: "complete", payment_status: "paid", metadata: checkouts.get(id), customer_details: { email }, created: 1 }));
    return answer({ object: "list", data, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The store's team record (lib/team.ts readTeam) cannot be read while `failTeam` is on; every other command runs as it does.
let failTeam = false;
let teamReads = 0;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  const team = commands.filter((c) => c[0] === "GET" && /^nl:team:[^:]+$/.test(String(c[1]))).length;
  teamReads += team;
  if (failTeam && team) throw new Error("Redis request failed with status 503");
  return run(commands);
};

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weeklyCall = (meet: "google" | null, room = "https://example.com/room") =>
  ({
    kind: "weekly",
    minutes: 60,
    tz: NY,
    weekly: WEEKDAYS,
    noticeHours: 1,
    horizonDays: 30,
    bufferMinutes: 0,
    room,
    video: false,
    meet,
    seats: 1,
    sessions: [],
  }) as unknown as CallSetup;

function host(email: string): TeamHost {
  return { email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 };
}

/** The n-th weekday from three days on, at 10:00 in New York: each booking on a day of its own. */
function weekdayAt(n: number): number {
  let seen = -1;
  for (let d = 3; d < 60; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    seen += 1;
    if (seen === n) return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), 600, NY) as number;
  }
  throw new Error("no weekday");
}

async function connectGoogle(store: Store, email: string, asHost: boolean): Promise<boolean> {
  const url = await beginConsent("google", {
    statsId: store.statsId as string,
    sid: store.sid,
    sessionCookie: `cookie-${email}`,
    email,
    ...(asHost ? { host: hostId(email), scopes: GOOGLE_HOST_SCOPES } : {}),
  });
  const state = new URL(url).searchParams.get("state") ?? "";
  const taken = await takeConsent("google", state, { sessionCookie: `cookie-${email}`, email });
  if (!taken) return false;
  const result = await finishConsent("google", {
    statsId: taken.statsId,
    code: email,
    verifier: taken.verifier,
    by: email,
    owner: { email: store.email, handle: store.handle },
    ...(asHost ? { host: taken.host } : {}),
  });
  return result.ok;
}

/**
 * A Pro store whose one call is hosted by Maya alone, who connected her own
 * Google Calendar for it and writes to her team calendar. With `meet`
 * "google" the store's owner connected the store's own Google too.
 */
async function teamStore(owner: string, handle: string, account: string, meet: "google" | null, room?: string): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(owner, handle, `${handle} studio`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(owner, made.product.id, weeklyCall(meet, room));
  const store = (await storeForEmail(owner)) as Store;
  if (!(await putMember(store, MAYA, "support"))) throw new Error("no member");
  const call = (await readListing(store, made.product.id)) as CallListing;
  await writeTeam(store, call.id, { mode: "round_robin", hosts: [host(MAYA)], createdAt: "2026-10-06T00:00:00.000Z" });
  if (!(await connectGoogle(store, MAYA, true))) throw new Error("Maya could not connect");
  if ((await setHostSource(store, MAYA, "google")) !== null) throw new Error("no source");
  if ((await setHostCalendars(store, MAYA, [MAYA, HOST_CALENDAR], HOST_CALENDAR)) !== null) throw new Error("no calendars");
  if ((await hostSync(store, MAYA, NY, { refresh: true })).state !== "ok") throw new Error("her calendar was not read");
  if (meet === "google" && !(await connectGoogle(store, owner, false))) throw new Error("the owner could not connect");
  stores.set(handle, store);
  return { store, call };
}

const stores = new Map<string, Store>();
/** Every five-minute run of the next hour, so each store's hourly look comes once. */
async function jobHour(): Promise<void> {
  const real = Date.now;
  try {
    for (let k = 0; k < 12; k += 1) {
      const at = real() + k * 300_000;
      Date.now = () => at;
      await syncMeetings(async (handle) => stores.get(handle) ?? null, at + 60_000, ORIGIN);
    }
  } finally {
    Date.now = real;
  }
}

async function booking(store: Store, call: CallListing, start: number, buyer: string) {
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: ORIGIN });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  const session = held.session;
  const scope = callScope(store.callsId as string, { group: false, session, product: call.id, start });
  return {
    session,
    scope,
    confirm: () => {
      paidBy.set(session, buyer);
      return confirmBooking({ store, product: call, session, start, end: start + HOUR, buyerEmail: buyer, buyerTz: NY, cancel: null, origin: ORIGIN });
    },
    move: () => moveBooking({ store, product: call, session, booked: { start, end: start + HOUR, email: buyer, buyerTz: NY }, start: start + 2 * HOUR, origin: ORIGIN }),
    link: (at: number) => roomOf(store.callsId, { product: call.id, setup: call.call, session, start: at, end: at + HOUR }),
  };
}

/** Writes on Maya's own connection since `from`: method and calendar path, the event id left out. */
const onMaya = (from: number) =>
  google
    .slice(from)
    .filter((g) => g.token === MAYA_TOKEN && g.method !== "GET" && g.path.includes("/calendar/v3/calendars/"))
    .map((g) => `${g.method} ${decodeURIComponent(g.path.split("/events")[0].replace("/google/calendar/v3/calendars/", ""))}`);
/** Writes on any connection but Maya's since `from`. */
const onStore = (from: number) =>
  google.slice(from).filter((g) => g.token && g.token !== MAYA_TOKEN && g.method !== "GET" && g.path.includes("/calendar/v3/calendars/")).map((g) => g.method);
const newLink = (from: number, to: string) => sent.slice(from).filter((m) => m.to === to && m.subject.startsWith("New link")).map((m) => m.text);
const ownerMail = (from: number, owner: string) => sent.slice(from).filter((m) => m.to === owner).map((m) => `${m.subject}\n${m.text}`);
const buyerMoved = (from: number, buyer: string) => sent.slice(from).find((m) => m.to === buyer && m.subject.startsWith("Moved"))?.text ?? "";
const due = async (scope: string) => {
  const record = (await readRecord(scope)) as MeetRecord;
  await writeRecord({ ...record, next: 1 });
  return record;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_host_calendar_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-for-tests";
  process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
  process.env.GOOGLE_CALENDAR_SYNC_SCOPES = "1";

  part("A host still on the team: as before");
  const quay = await teamStore("quay@example.com", "quay", "acct_1TestQuay00001", null);
  const q = await booking(quay.store, quay.call, weekdayAt(0), "kai@example.com");
  let mark = google.length;
  await q.confirm();
  is("the event is made on her calendar, on her connection", onMaya(mark), [`POST ${HOST_CALENDAR}`]);
  mark = google.length;
  is("the move goes through", (await q.move()).ok, true);
  is("her event moves there", onMaya(mark), [`PATCH ${HOST_CALENDAR}`]);
  is("and the buyer keeps her Meet link", await q.link(weekdayAt(0) + 2 * HOUR), HOST_LINK);

  part("Removed before the confirmation");
  const harbor = await teamStore("harbor@example.com", "harbor", "acct_1TestHarbor0001", null);
  const h = await booking(harbor.store, harbor.call, weekdayAt(1), "lee@example.com");
  is("removed through the team's own removal", await removeMember(harbor.store, MAYA), true);
  mark = google.length;
  await h.confirm();
  is("nothing is written on the calendar of the host who left", onMaya(mark), []);
  is("no meeting record names her", (await readRecord(h.scope))?.host === hostId(MAYA), false);
  is("the buyer is given the call's own room", await h.link(weekdayAt(1)), "https://example.com/room");

  const dock = await teamStore("dock@example.com", "dock", "acct_1TestDock00001", "google");
  const d = await booking(dock.store, dock.call, weekdayAt(2), "ivy@example.com");
  await removeMember(dock.store, MAYA);
  mark = google.length;
  await d.confirm();
  is("on a call set to Google: nothing on her calendar", onMaya(mark), []);
  is("the meeting is made on the store's own connection", [onStore(mark), (await readRecord(d.scope))?.host], [["POST"], ""]);
  is("and its link is the store's", await d.link(weekdayAt(2)), STORE_LINK);

  part("Removed before a move");
  const reef = await teamStore("reef@example.com", "reef", "acct_1TestReef00001", "google");
  const R = weekdayAt(3);
  const r = await booking(reef.store, reef.call, R, "ana@example.com");
  await r.confirm();
  is("made on her calendar while she was on the team", (await readRecord(r.scope))?.host, hostId(MAYA));
  await removeMember(reef.store, MAYA);
  mark = google.length;
  let sentMark = sent.length;
  is("the move goes through", (await r.move()).ok, true);
  is("her event is not moved: it is deleted from her calendar", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("the meeting at the new time is the store's", [onStore(mark), (await readRecord(r.scope))?.host, (await readRecord(r.scope))?.start], [["POST"], "", R + 2 * HOUR]);
  is("the buyer's link is the store's", await r.link(R + 2 * HOUR), STORE_LINK);
  // Added with the fix (rule 23: a new check, none changed): the new link is counted, so the move's calendar file replaces the one sent before.
  is("the new link is counted as a replaced one", (await readRecord(r.scope))?.updates, 1);
  is("and the buyer's Moved email carries it", buyerMoved(sentMark, "ana@example.com").includes(STORE_LINK), true);

  const cove = await teamStore("cove@example.com", "cove", "acct_1TestCove00001", null);
  const C = weekdayAt(4);
  const c = await booking(cove.store, cove.call, C, "bo@example.com");
  await c.confirm();
  await removeMember(cove.store, MAYA);
  mark = google.length;
  sentMark = sent.length;
  is("on a call not set to Google, the move goes through", (await c.move()).ok, true);
  is("her event is deleted, not moved", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("the buyer is given the call's own room", await c.link(C + 2 * HOUR), "https://example.com/room");
  is("and the buyer's Moved email carries it, not her Meet link", [buyerMoved(sentMark, "bo@example.com").includes("https://example.com/room"), buyerMoved(sentMark, "bo@example.com").includes(HOST_LINK)], [true, false]);

  part("Her event's removal is tried again when Google fails");
  const bay = await teamStore("bay@example.com", "bay", "acct_1TestBay000001", "google");
  const B = weekdayAt(5);
  const b = await booking(bay.store, bay.call, B, "eli@example.com");
  await b.confirm();
  await removeMember(bay.store, MAYA);
  googleDown = true;
  try {
    is("the move goes through while Google is down", (await b.move()).ok, true);
  } finally {
    googleDown = false;
  }
  const left = (await readRecord(`${b.scope}:left`)) as MeetRecord | null;
  is("what is left on her calendar is written down to remove", [left?.todo, left?.gone, left?.host], ["delete", true, hostId(MAYA)]);
  await due(`${b.scope}:left`);
  mark = google.length;
  await retryRecord(bay.store, `${b.scope}:left`, async () => 1);
  is("the five-minute job deletes it, and only that", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("and has nothing left to do", (await readRecord(`${b.scope}:left`))?.todo, "");

  part("A team that cannot be read (rule 24)");
  const pier = await teamStore("pier@example.com", "pier", "acct_1TestPier00001", "google");
  const p1 = await booking(pier.store, pier.call, weekdayAt(6), "noa@example.com");
  mark = google.length;
  failTeam = true;
  try {
    await p1.confirm();
  } finally {
    failTeam = false;
  }
  is("at the confirmation: nothing on her calendar, the store's meeting", [onMaya(mark), onStore(mark)], [[], ["POST"]]);
  const P = weekdayAt(7);
  const p2 = await booking(pier.store, pier.call, P, "zoe@example.com");
  await p2.confirm();
  is("made on her calendar while the team could be read", (await readRecord(p2.scope))?.host, hostId(MAYA));
  mark = google.length;
  failTeam = true;
  let pierMoved: Awaited<ReturnType<typeof p2.move>>;
  try {
    pierMoved = await p2.move();
  } finally {
    failTeam = false;
  }
  is("at a move: it goes through", pierMoved.ok, true);
  is("her event is never moved, only deleted", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("and the store's meeting takes the new time", (await readRecord(p2.scope))?.host, "");

  part("The five-minute job and a host who has left");
  const isle = await teamStore("isle@example.com", "isle", "acct_1TestIsle00001", null);
  const I1 = weekdayAt(8);
  const i1 = await booking(isle.store, isle.call, I1, "max@example.com");
  googleDown = true;
  try {
    await i1.confirm();
  } finally {
    googleDown = false;
  }
  is("a meeting that could not be made is left to the job, on her calendar", [(await readRecord(i1.scope))?.todo, (await readRecord(i1.scope))?.host], ["create", hostId(MAYA)]);
  const I2 = weekdayAt(9);
  const i2 = await booking(isle.store, isle.call, I2, "sky@example.com");
  await i2.confirm();
  await removeMember(isle.store, MAYA);
  // A move whose PATCH failed earlier, while she was on the team, left the job a PATCH to do.
  const made = (await readRecord(i2.scope)) as MeetRecord;
  await writeRecord({ ...made, start: I2 + HOUR, end: I2 + 2 * HOUR, todo: "patch", tries: 1, next: 1, error: "Google did not answer" });
  await due(i1.scope);
  mark = google.length;
  await retryRecord(isle.store, i1.scope, async () => 1);
  // Rule 23: the check below was "the job makes nothing on her calendar and moves nothing there", with her DELETEs
  // filtered out of it, over both records; the job's pending move (i2) is checked on its own after it now.
  is("the job makes nothing on her calendar for a meeting it could not make", onMaya(mark), []);
  // Rule 23: was "neither record waits on her any more" over i1 and i2; i2 is checked below.
  is("and that record waits on her no more", (await readRecord(i1.scope))?.todo, "");
  is("the buyer still has the room given at the confirmation", await i1.link(I1), "https://example.com/room");
  mark = google.length;
  sentMark = sent.length;
  await jobHour();
  is("a move the job had to make on her calendar: her event is deleted there instead", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("and the booking waits on her no more", [(await readRecord(i2.scope))?.host, (await readRecord(i2.scope))?.todo], ["", ""]);
  is("the buyer is given the call's room", await i2.link(I2), "https://example.com/room");
  is(
    "and is emailed it, told the link they had is no longer the one",
    newLink(sentMark, "sky@example.com").map((t) => [t.includes("https://example.com/room"), t.includes(HOST_LINK)]),
    [[true, true]],
  );

  part("Removed with no move at all: the five-minute job");
  const fjord = await teamStore("fjord@example.com", "fjord", "acct_1TestFjord0001", "google");
  const F = weekdayAt(10);
  const f = await booking(fjord.store, fjord.call, F, "una@example.com");
  await f.confirm();
  is("made on her calendar while she was on the team", (await readRecord(f.scope))?.host, hostId(MAYA));
  await removeMember(fjord.store, MAYA);
  mark = google.length;
  sentMark = sent.length;
  failTeam = true;
  try {
    await jobHour();
  } finally {
    failTeam = false;
  }
  is("a team that cannot be read: nothing is changed", [onMaya(mark), onStore(mark), newLink(sentMark, "una@example.com")], [[], [], []]);
  mark = google.length;
  sentMark = sent.length;
  await jobHour();
  is("her event is deleted from her calendar", onMaya(mark), [`DELETE ${HOST_CALENDAR}`]);
  is("the store's own meeting takes its place", [onStore(mark), (await readRecord(f.scope))?.host, await f.link(F)], [["POST"], "", STORE_LINK]);
  is(
    "the buyer is emailed the new link, and told the old one is no longer the one",
    newLink(sentMark, "una@example.com").map((t) => [t.includes(STORE_LINK), t.includes(HOST_LINK)]),
    [[true, true]],
  );
  is("the owner is told why", ownerMail(sentMark, "fjord@example.com").some((t) => t.includes("no longer on your team") && t.includes(STORE_LINK)), true);
  is("nothing reaches the host who left", sent.slice(sentMark).some((m) => m.to === MAYA), false);
  mark = google.length;
  sentMark = sent.length;
  await jobHour();
  is("done once: the next hour changes nothing and emails nobody", [onMaya(mark), onStore(mark), sent.length - sentMark], [[], [], 0]);

  part("A move that leaves the booking with no link at all");
  const mere = await teamStore("mere@example.com", "mere", "acct_1TestMere00001", null, "");
  const M = weekdayAt(11);
  const m = await booking(mere.store, mere.call, M, "jo@example.com");
  await m.confirm();
  await removeMember(mere.store, MAYA);
  sentMark = sent.length;
  is("the move goes through", (await m.move()).ok, true);
  is("the owner's Moved email asks them to send a link", ownerMail(sentMark, "mere@example.com").some((t) => t.startsWith("Moved") && t.includes("You have not set a meeting link, so send them one")), true);

  part("A collective call's hosts are checked with one read of the team");
  const reads = async (collective: boolean, n: number) => {
    const owner = `${collective ? "col" : "rr"}${n}@example.com`;
    const handle = `${collective ? "col" : "rr"}team${n}`;
    const { store, call } = await teamStore(owner, handle, `acct_1Test${handle.padEnd(10, "0").slice(0, 10)}`, null);
    if (collective) {
      for (const other of ["pat@example.com", "rio@example.com"]) await putMember(store, other, "support");
      await writeTeam(store, call.id, { mode: "collective", hosts: [host(MAYA), host("pat@example.com"), host("rio@example.com")], createdAt: "2026-10-06T00:00:00.000Z" });
    }
    const b = await booking(store, call, weekdayAt(12 + n), `buyer${n}@example.com`);
    const before = teamReads;
    await b.confirm();
    return { reads: teamReads - before, host: (await readRecord(b.scope))?.host };
  };
  const one = await reads(false, 0);
  const three = await reads(true, 1);
  is("both made on her calendar", [one.host, three.host], [hostId(MAYA), hostId(MAYA)]);
  is("three hosts read the team as often as one", three.reads, one.reads);

  done();
}

void main();
