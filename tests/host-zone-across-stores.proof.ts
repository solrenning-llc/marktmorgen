/**
 * Proof only (not in the CI run): a host's busy times are kept per host, for
 * every store they host on (lib/host-calendar.ts, nl:hostcal:good:<host>), but
 * the zone a private iCal feed's floating times are read in comes from the
 * request body of app/api/store/host-calendar, and the studio calendar page
 * sends "UTC" on a store where the person hosts nothing
 * (app/studio/calendar/page.tsx, `let tz = "UTC"`).
 *
 * Two stores, all synthetic: on store A the host is on the team of a weekly
 * call, in America/New_York; store B is their own and has no call. One
 * private iCal feed, served by a local stand-in (no network), with two
 * floating events (no TZID, no X-WR-TIMEZONE) on one weekday: 10:00-11:00 and
 * 19:00-20:00. Control: the feed added from store A's page (tz New York).
 * Fault: "Check now" pressed on store B's page (tz UTC). Then store A's real
 * booking code (slotsForProduct, holdAndCheckout) is asked about 10:00 and
 * 14:00 New York.
 */
import { createServer, connect, type AddressInfo } from "node:net";
import https from "node:https";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/host-calendar/route";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { writeTeam } from "@/lib/team-booking";
import { hostId, readClaims } from "@/lib/host-claims";
import { SYNC_SECONDS } from "@/lib/host-calendar";
import { redisPipeline, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

// ---- Stand-ins: Stripe and Resend answer; any other fetch is refused -------------
let checkouts = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  if (url.hostname !== "api.stripe.com") throw new Error(`Unexpected external request to ${url.hostname}`);
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    checkouts += 1;
    const id = `cs_test_hzp${String(checkouts).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// ---- The private iCal feed: a local plain server behind the HTTPS agent ------------
let ics = "";
const feedHits: string[] = [];
const server = createServer((socket) => {
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk.toString("latin1");
    if (!raw.includes("\r\n\r\n")) return;
    feedHits.push(raw.split("\r\n")[0]);
    const body = Buffer.from(ics, "utf8");
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/calendar\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.toString("latin1")}`, "latin1");
  });
});
// lib/safe-fetch.ts checks the URL (a public IP, port above 1023, so no DNS lookup) and then
// calls https.request with no agent: the global agent's connection goes to the stand-in instead.
const FEED_URL = "https://93.184.216.34:8443/private/basic.ics";
let feedPort = 0;
(https.globalAgent as unknown as { createConnection: (o: { host?: string; port?: number }) => unknown }).createConnection = (o) => {
  if (o.host !== "93.184.216.34" || Number(o.port) !== 8443) throw new Error(`Unexpected HTTPS connection to ${o.host}:${o.port}`);
  return connect(feedPort, "127.0.0.1");
};

// ---- Fixtures ----------------------------------------------------------------------
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0,
  room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;
const host = (email: string): TeamHost => ({ email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 });

/** A weekday at least `days` from now in New York: its date parts. */
function weekdayParts(days: number): { y: number; m: number; d: number } {
  for (let k = days; k < days + 8; k += 1) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(Date.now() + k * DAY));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
  }
  throw new Error("no weekday");
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_host_zone_proof_only";
  process.env.RESEND_API_KEY = "re_test_host_zone_proof_only";
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  feedPort = (server.address() as AddressInfo).port;

  const day = weekdayParts(3);
  const stamp = `${day.y}${String(day.m).padStart(2, "0")}${String(day.d).padStart(2, "0")}`;
  ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Synthetic//Host zone proof//EN",
    "BEGIN:VEVENT", "UID:morning@proof.example", "DTSTAMP:20261101T000000Z", `DTSTART:${stamp}T100000`, `DTEND:${stamp}T110000`, "SUMMARY:Dentist", "END:VEVENT",
    "BEGIN:VEVENT", "UID:evening@proof.example", "DTSTAMP:20261101T000000Z", `DTSTART:${stamp}T190000`, `DTEND:${stamp}T200000`, "SUMMARY:Dinner", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const T10 = zonedToUtc(day.y, day.m, day.d, 600, NY) as number; // 10:00 New York: really busy
  const T14 = zonedToUtc(day.y, day.m, day.d, 840, NY) as number; // 14:00 New York: really free
  const T19 = zonedToUtc(day.y, day.m, day.d, 1140, NY) as number;
  const U10 = Date.UTC(day.y, day.m - 1, day.d, 10); // the same floating 10:00, read as UTC
  const U19 = Date.UTC(day.y, day.m - 1, day.d, 19);

  part("Two stores, one host");
  const OWNER_A = "owner-a@example.test";
  const HOST = "host@example.test";
  await claimHandle(OWNER_A, "hzpharbor", "Harbor studio", "");
  await ensureStatsId(OWNER_A);
  await ensureStoreId(OWNER_A);
  await setStripeAccount(OWNER_A, "acct_1TestHzpHarbor01", true);
  await setSubscription(OWNER_A, { customerId: "cus_hzpharbor001", subscriptionId: "sub_hzpharbor001", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER_A, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER_A, made.product.id, weekly);
  let storeA = (await storeForEmail(OWNER_A)) as Store;
  const call = (await readListing(storeA, made.product.id)) as CallListing;
  is("the host joins store A's team", await putMember(storeA, HOST, "editor"), true);
  await writeTeam(storeA, call.id, { mode: "round_robin", hosts: [host(HOST)], createdAt: "2026-10-01T00:00:00.000Z" });
  storeA = (await storeForEmail(OWNER_A)) as Store;

  await claimHandle(HOST, "hzplantern", "Lantern studio", "");
  await ensureStatsId(HOST);
  await ensureStoreId(HOST);
  await setSubscription(HOST, { customerId: "cus_hzplantern01", subscriptionId: "sub_hzplantern01", active: true, tier: "pro", period: paidPeriod() });
  const storeB = (await storeForEmail(HOST)) as Store;
  is("store B is the host's own and has no team call", [storeB.sid !== storeA.sid, Boolean(storeB.sid)], [true, true]);

  const cookie = `${SESSION_COOKIE}=${await openSession(HOST)}`;
  const post = (sid: string, body: Record<string, unknown>) =>
    POST(new NextRequest(`https://marktmorgen.com/api/store/host-calendar?store=${sid}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const kept = async () => {
    const [raw] = await redisPipeline([["GET", `nl:hostcal:good:${hostId(HOST)}`]]);
    return (JSON.parse(String(raw)) as { busy: [number, number][] }).busy;
  };
  const offeredA = async () => {
    const read = await slotsForProduct((await storeForEmail(OWNER_A)) as Store, call);
    const starts = new Set((read?.days ?? []).flatMap((d) => d.starts));
    return { t10: starts.has(T10), t14: starts.has(T14), total: starts.size };
  };

  part("Control: the feed added from store A's page, in the host's New York zone");
  const added = await post(storeA.sid as string, { action: "ics-add", url: FEED_URL, tz: NY });
  is("the real route adds the feed from store A", [added.status, (await added.json()).ok], [200, true]);
  const controlBusy = await kept();
  is("floating times kept in New York: 10:00-11:00 and 19:00-20:00 New York", controlBusy, [[T10, T10 + HOUR], [T19, T19 + HOUR]]);
  const control = await offeredA();
  is("store A's booking page: 10:00 New York not offered, 14:00 New York offered", [control.t10, control.t14], [false, true]);

  part("Fault: Check now pressed on store B's page, which sends UTC");
  const checked = await post(storeB.sid as string, { action: "check", tz: "UTC" });
  is("the real route accepts the check on store B", [checked.status, (await checked.json()).ok], [200, true]);
  const faultBusy = await kept();
  is("the same host-wide reading is now kept in UTC", faultBusy, [[U10, U10 + HOUR], [U19, U19 + HOUR]]);
  is("shifted by the New York offset (hours)", (U10 - T10) / HOUR, -5);
  const fault = await offeredA();
  is("store A now offers 10:00 New York (the host is at the dentist)", fault.t10, true);
  is("store A now hides 14:00 New York (the host is free)", fault.t14, false);

  const full = (await readProduct((await storeForEmail(OWNER_A)) as Store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store: (await storeForEmail(OWNER_A)) as Store, product: full, start: T10, buyerTz: "Europe/Lisbon", origin: "https://marktmorgen.com" });
  const claims = ((await readClaims([hostId(HOST)])).get(hostId(HOST)) ?? []).map((c) => c.start);
  is("a buyer on store A can hold, and get a checkout for, the busy 10:00 New York", [held.ok, claims.includes(T10), checkouts], [true, true, 1]);

  part("How long it lasts");
  offset = SYNC_SECONDS * 1000 - 60_000;
  const later = await offeredA();
  // 10:00 is now taken by the hold above (lib/host-claims.ts), so only 14:00 still shows the wrong reading.
  is("14 minutes later store A still hides the free 14:00 and has not read the feed again", [await kept(), later.t14, feedHits.length], [faultBusy, false, 2]);
  offset = SYNC_SECONDS * 1000 + 1_000;
  const repaired = await offeredA();
  is("after SYNC_SECONDS store A's own page reads again in New York", [await kept(), repaired.t14, feedHits.length], [controlBusy, true, 3]);

  console.log("HOST_ZONE_ACROSS_STORES", JSON.stringify({
    day: stamp, control: { busy: controlBusy, offered: control }, fault: { busy: faultBusy, offered: fault, held: held.ok }, later, repaired, feedHits: feedHits.length,
  }));
  server.close();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
