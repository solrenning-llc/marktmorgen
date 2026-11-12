/**
 * A booking's "call.booked" webhook is never lost when telling the webhooks fails (issue #3937).
 *
 * emitEvent throws on purpose "so the caller tries again" when the event's once-only mark answers unknown or the
 * deliveries cannot be written (lib/webhooks.ts). Before: confirmBooking wrote the booking's once-only confirmation
 * mark first and swallowed that throw afterward, and every caller that confirms again (the mail job, catchUpBookings,
 * the thanks page) leaves a confirmed booking alone, so the creator's endpoint never heard of the booking. Now the
 * event is recorded before the confirmation mark: a failure throws, the mail job keeps the booking queued, and its
 * next run confirms it and tells the endpoint once.
 *
 * Against the real code (holdAndCheckout, sendCallReminders, confirmBooking, emitEvent, deliverDue) with the in-memory
 * Redis, a stand-in for Stripe and a local HTTP endpoint behind lib/safe-fetch.ts; synthetic only.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, isConfirmed } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { addEndpoint, deliverDue, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { HOLD_SECONDS } from "@/lib/stripe-account";

const NY = "America/New_York";

let sessions = 0;
const paidRows: Record<string, unknown>[] = [];
const heldMeta = new Map<string, Record<string, string>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_bookhook${String(sessions).padStart(10, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find((r) => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What the creator's endpoint received, one parsed body a request. */
const received: { type: string; data: Record<string, unknown> }[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    try {
      received.push(JSON.parse(body));
    } catch {
      received.push({ type: "unreadable", data: {} });
    }
    response.writeHead(200);
    response.end("ok");
  });
});

class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const isMark = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:hooks:evt:") && cmd.includes("NX");
/** How many of the next pipelines holding an event's once-only mark throw, as a passing Upstash timeout would. */
let markThrows = 0;
redis.pipeline = (async (commands: Cmd[]) => {
  if (markThrows > 0 && commands.some(isMark)) {
    markThrows -= 1;
    throw new Error("synthetic: the event mark's SET NX timed out");
  }
  // The webhook queue's lease (LEASE_SCRIPT in lib/webhooks.ts), as Redis runs it (as in tests/r24-webhook-event-claim.test.ts).
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return original(commands);
}) as typeof redis.pipeline;

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

async function main() {
  const originalNow = Date.now;
  const realNow = originalNow.bind(Date);
  let clock = originalNow();
  Date.now = () => clock;
  try {
    redis.clear();
    console.error = () => {};
    process.env.STRIPE_SECRET_KEY = "sk_test_3937_booked";
    process.env.RESEND_API_KEY = "re_test_3937_booked";
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

    const email = "bookhook@example.com";
    await claimHandle(email, "bookhook", "Book Hook studio", "");
    await ensureStatsId(email);
    await setStripeAccount(email, "acct_1TestBookHk01", true);
    await setSubscription(email, { customerId: "cus_bookhook00001", subscriptionId: "sub_bookhook00001", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(email, "Strategy call", "", "120", null);
    if (!made.ok) throw new Error("no product");
    await setProductCall(email, made.product.id, weekly);
    const store = (await storeForEmail(email)) as Store;
    const endpoint = await addEndpoint(store, "https://hooks.example.com/bookings", ["call.booked"]);
    if (!endpoint.ok) throw new Error("no endpoint");
    const call = (await readListing(store, made.product.id)) as CallListing;
    const find = async (handle: string) => (handle === store.handle ? ((await storeForEmail(email)) as Store) : null);

    const book = async (days: number) => {
      const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
      const start = weekdayAt(days, 600);
      const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
      if (!held.ok) throw new Error(`no hold: ${held.reason}`);
      paidRows.push({ id: held.session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: "buyer@example.com" }, metadata: heldMeta.get(held.session) });
      return { session: held.session, member: reminderMember(store.callsId!, store.handle, held.session, "c", start) };
    };
    const queued = async (member: string) => {
      const [rows] = await original([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
      return Array.isArray(rows) && rows.includes(member);
    };
    /** Waits for the endpoint's requests in flight: until nothing new arrives for 300 ms, at most 5 seconds. */
    const settle = async () => {
      const until = realNow() + 5_000;
      let seen = -1;
      while (seen !== received.length && realNow() < until) {
        seen = received.length;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    const job = async () => {
      const counts = await sendCallReminders(find, clock + 60_000, "https://marktmorgen.com");
      await deliverDue(clock + 60_000);
      await settle();
      return counts;
    };
    const booked = (session: string) => received.filter((r) => r.type === "call.booked" && r.data.checkout_session === session).length;

    const healthy = await book(9);
    clock += HOLD_SECONDS * 1000 + 120_000;
    const good = await job();
    is("healthy control: confirmed once, the endpoint told once, the queue cleared", [good.confirmed, await isConfirmed(healthy.session), booked(healthy.session), await queued(healthy.member)], [1, true, 1, false]);

    const bad = await book(10);
    clock += HOLD_SECONDS * 1000 + 120_000;
    markThrows = 1;
    const failed = await job();
    is("control: the event mark did time out", markThrows, 0);
    is("the endpoint heard nothing yet", booked(bad.session), 0);
    is("the booking is not counted confirmed while its event is not recorded", [failed.confirmed, await isConfirmed(bad.session)], [0, false]);
    is("it stays queued for the next run", await queued(bad.member), true);
    clock += 5 * 60_000;
    const retried = await job();
    is("the next run confirms it and tells the endpoint once", [retried.confirmed, await isConfirmed(bad.session), booked(bad.session)], [1, true, 1]);
    is("then the queue is clear", await queued(bad.member), false);
    clock += 5 * 60_000;
    await job();
    is("never told twice", [booked(bad.session), booked(healthy.session)], [1, 1]);
    server.close();
    done();
  } finally {
    Date.now = originalNow;
  }
}
main().catch((error) => {
  console.log(String(error?.stack ?? error));
  server.close();
  process.exitCode = 1;
});
