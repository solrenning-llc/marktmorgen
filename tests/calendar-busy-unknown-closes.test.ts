/**
 * Focal return on #3339, finding 2 (CX-123 rule 24): the creator's calendars
 * are read for every call time offered (lib/calls.ts readBusy, through
 * lib/calendar-sync.ts calendarBusy). A read that fails on the way there, such
 * as the call listing's GET that gives the zone for all-day times
 * (homeZone), must never read as "nothing busy".
 *
 * Held here, with synthetic data only:
 *   - calendarBusy answers, never rejects: with the listing read failing, every
 *     calendar's whole window is busy and counted as failing;
 *   - the booking page then offers no time, and so never the creator's busy
 *     hour; holdAndCheckout opens no checkout for it;
 *   - controls: with every read answering, the busy hour is not offered and the
 *     other times are.
 *
 * Network: none. The calendar is added through a local plain server (the
 * LocalAgent pattern of tests/ics-file-budget.test.ts); the reading it keeps
 * is used by the booking page, and Stripe is a stand-in.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { addFeed, calendarBusy, LOOKAHEAD_DAYS } from "@/lib/calendar-sync";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";

let opened = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_calunknown${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// While `failListing` is above zero, that many GETs of a call listing record fail as a dropped connection does,
// counting only those sent once the calendar settings have answered: the one calendarBusy sends for the zone of
// all-day times (homeZone). The booking page's own read of its dated sessions goes first and answers.
let failListing = 0;
let failedListing = 0;
let settingsAnswered = false;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  if (settingsAnswered && failListing > 0 && commands.some((c) => c[0] === "GET" && /^nl:catalog:[^:]+:l:/.test(String(c[1])))) {
    failListing -= 1;
    failedListing += 1;
    throw new Error("connection reset");
  }
  const replies = await run(commands);
  if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:cal:cfg:"))) settingsAnswered = true;
  return replies;
};
/** Arms one failing listing read for the next calendar reading. */
function failNextZoneRead(): void {
  failListing = 1;
  failedListing = 0;
  settingsAnswered = false;
}

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};

const served = new Map<string, string>();
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/calendar; charset=utf-8");
  response.end(served.get((request.url ?? "/").split("?")[0]) ?? "");
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

async function callStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing; full: Product & { call: CallSetup } }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cal_unknown_only";
  process.env.RESEND_API_KEY = "re_test_cal_unknown_only";
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const hooks = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) };

  const { store: saved, call, full } = await callStore("calunknown@example.com", "calunknown", "acct_1TestCalUnknown");
  // The call listing read from its own record, as for a store whose head does not hold it.
  const store: Store = { ...saved, catalog: { ...saved.catalog, head: [] } };
  const busyHour = weekdayAt(9, 600);
  served.set("/own.ics", `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:own@example.com\r\nDTSTART:${stamp(busyHour)}\r\nDTEND:${stamp(busyHour + HOUR)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  const added = await addFeed(store, "https://calendar.unknown.example.org/own.ics", Date.now(), hooks);
  is("setup: the creator's calendar is added", added.ok, true);

  const offered = async (): Promise<number[] | null> => {
    const slots = await slotsForProduct(store, call);
    return slots ? slots.days.flatMap((d) => d.starts) : null;
  };

  part("Controls: every read answers");
  {
    const read = await calendarBusy(store, Date.now());
    is("control: no calendar failing, the busy hour among the busy times", [read.failing, read.busy.some((b) => b.start <= busyHour && b.end >= busyHour + HOUR)], [0, true]);
    const times = await offered();
    is("control: the creator's busy hour is not offered, other times are", [times?.includes(busyHour), (times?.length ?? 0) > 0], [false, true]);
  }

  part("The call listing's read fails inside calendarBusy: the window is busy, never free");
  {
    failNextZoneRead();
    const now = Date.now();
    const read = await calendarBusy(store, now).then(
      (answer) => answer,
      (error: unknown) => ({ rejected: error instanceof Error ? error.message : String(error) }),
    );
    is("setup: the listing read failed once", failedListing, 1);
    is("calendarBusy answers rather than rejecting", "rejected" in read ? read.rejected : "answered", "answered");
    const busy = "busy" in read ? read.busy : [];
    is("its calendar counts as failing", "failing" in read ? read.failing : null, 1);
    is(
      "the whole window is busy (from a day back to the end of the window)",
      busy.some((b) => b.start <= now - DAY + 1 && b.end >= now + LOOKAHEAD_DAYS * DAY - 1),
      true,
    );
    failListing = 0;
  }

  part("The booking page with the same failure: no time is offered, so never the busy hour");
  {
    failNextZoneRead();
    const times = await offered();
    is("setup: the listing read failed once", failedListing, 1);
    is("the creator's busy hour is not offered", times?.includes(busyHour) ?? false, false);
    is("no time is offered at all (the calendar's busy times are not known)", times?.length ?? 0, 0);
    failListing = 0;
  }

  part("Selling the busy hour with the same failure: no checkout");
  {
    failNextZoneRead();
    const before = opened;
    const held = await holdAndCheckout({ store, product: full, start: busyHour, buyerTz: NY, origin: "https://marktmorgen.com" });
    is("setup: a listing read failed", failedListing >= 1, true);
    is("the busy hour is not sold, and no checkout is opened", [held.ok, opened - before], [false, 0]);
    failListing = 0;
  }

  part("Controls again: with every read answering, the page is as before");
  {
    const times = await offered();
    is("control: the busy hour is not offered, other times are", [times?.includes(busyHour), (times?.length ?? 0) > 0], [false, true]);
  }

  server.close();
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
