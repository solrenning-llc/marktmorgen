/**
 * A team booking whose team cannot be read stays queued for the mail job's next run (Codex G on #3080; his proof,
 * SHA-256 505de75a6f36132fc5500d8b2bad62a65418d0cba7557209aea1fe98704f4997, kept here with its assertions).
 *
 * confirmBooking read the team before its once-only mark and, when that read failed, returned normally. The mail
 * job (lib/call-reminders.ts, sendCallReminders) then counted the booking confirmed and took its "c" member off the
 * queue, so the next run never tried again: the paid booking stayed unconfirmed and its hosts' claim on the time ran
 * out with the hold. A failed read now throws, which the job keeps in the queue (as for any confirmation that
 * throws), and a healthy run later confirms it and keeps the claim for good (CX-123 rule 24: an unknown team is
 * never "no team" and a booking left unconfirmed is never counted as confirmed).
 *
 * Against the real code with an in-memory Redis and a stand-in for Stripe; synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, isConfirmed } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { hostId, readClaims } from "@/lib/host-claims";
import { writeTeam } from "@/lib/team-booking";
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
    const id = `cs_test_teamread${String(sessions).padStart(10, "0")}`;
    const body = new URLSearchParams(String(init?.body));
    heldMeta.set(id, Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k,v]) => [k.slice(9,-1),v])));
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === "/checkout/sessions") return answer({ object: "list", data: paidRows, has_more: false });
  if (method === "GET" && path.startsWith("/checkout/sessions/")) return answer(paidRows.find(r => r.id === path.split("/").at(-1)) ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The team's Redis read fails while `failTeams` is on; every other command runs as it does.
let failTeams = false;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  if (failTeams && commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:callteam:"))) throw new Error("Redis request failed with status 503");
  return run(commands);
};

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

function host(email: string): TeamHost {
  return { email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 };
}

async function teamStore(email: string, handle: string, account: string): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  await writeTeam(store, call.id, { mode: "round_robin", hosts: [host(email)], createdAt: "2026-10-06T00:00:00.000Z" });
  return { store, call };
}

async function hold(store: Store, call: CallListing, start: number): Promise<string> {
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  return held.session;
}

const claimAt = async (email: string, start: number) => ((await readClaims([hostId(email)])).get(hostId(email)) ?? []).find((c) => c.start === start);

async function main() {
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  try {
    redis.clear();
    process.env.STRIPE_SECRET_KEY = "sk_test_g3080_job";
    process.env.RESEND_API_KEY = "re_test_g3080_job";
    const stores = new Map<string, Store>();
    const find = async (handle: string) => stores.get(handle) ?? null;
    const add = async (email: string, handle: string, account: string, days: number) => {
      const entry = await teamStore(email, handle, account);
      stores.set(handle, entry.store);
      const start = weekdayAt(days, 600);
      const session = await hold(entry.store, entry.call, start);
      paidRows.push({ id: session, status: "complete", payment_status: "paid", created: Math.floor(clock / 1000), amount_total: 12000, currency: "usd", customer_details: { email: "buyer@example.com" }, metadata: heldMeta.get(session) });
      const member = reminderMember(entry.store.callsId!, handle, session, "c", start);
      return { ...entry, email, start, session, member };
    };
    const queued = async (member: string) => {
      const [rows] = await redis.pipeline([["ZRANGEBYSCORE", REMINDER_QUEUE, 0, "+inf"]]);
      return Array.isArray(rows) && rows.includes(member);
    };
    const job = () => sendCallReminders(find, clock + 60000, "https://marktmorgen.com");
    const healthy = await add("gquay@example.com", "gquay", "acct_1TestGQuay01", 9);
    clock += HOLD_SECONDS * 1000 + 120000;
    const good = await job();
    is("healthy real job confirms once, preserves permanent host claim, and consumes queue", [good.confirmed, await isConfirmed(healthy.session), (await claimAt(healthy.email, healthy.start))?.until, await queued(healthy.member)], [1, true, 0, false]);

    const bad = await add("gpier@example.com", "gpier", "acct_1TestGPier01", 10);
    clock += HOLD_SECONDS * 1000 + 120000;
    is("confirmation entry written by real hold is due before fault", await queued(bad.member), true);
    failTeams = true;
    const failed = await job();
    failTeams = false;
    is("unknown team is never counted as a confirmed booking", failed.confirmed, 0);
    is("unconfirmed paid booking stays queued for retry", await queued(bad.member), true);
    is("failed team read does not mark booking confirmed", await isConfirmed(bad.session), false);
    clock += 5 * 60000;
    const retried = await job();
    is("healthy next mail run confirms booking and retains its host", [retried.confirmed, await isConfirmed(bad.session), (await claimAt(bad.email, bad.start))?.until], [1, true, 0]);
    is("confirmation queue is clear after next run", await queued(bad.member), false);
    clock += 11 * 60000;
    is("paid host claim stays permanent beyond the original hold margin", (await claimAt(bad.email, bad.start))?.until, 0);
    done();
  } finally {
    failTeams = false;
    Date.now = originalNow;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
