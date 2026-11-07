/**
 * Claude 5's MEDIUM on #2844 (head 91815567): the affiliates job runs once a
 * day (vercel.json, "0 13 * * *") and looks at a store only on its own payday.
 * A PayPal link that could not be read on that day threw with the month left
 * unclaimed, and the comment promised that "the next run" would pay or remind:
 * the next run is the next day, when the store is no longer on its payday, so
 * that month the creator got neither a PayPal batch nor an email.
 *
 * Now a link that cannot be read is never permission to pay: the month is
 * claimed on that same run and the manual reminder goes, saying the link could
 * not be read, with nothing sent to PayPal. The run is checked over the real
 * schedule: payday at 13:00 UTC on the 5th, then the 6th, 7th, 15th and 30th.
 *
 * Synthetic only: a stand-in for PayPal's and Resend's APIs, the Redis stub.
 */
import { connectPayPal, setAutoPay } from "@/lib/paypal-payouts";
import { paydayEmail, sendPaydayEmails } from "@/lib/affiliate-payday";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "c0dec0dec0dec0dec0dec0dec0dec0d5";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
const OWNER = "owner-unread-link@example.com";
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname === "api.resend.com") return json({ id: "synthetic-email" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING" } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "", handle: "harborunread", name: "Harbor Kitchen", email: OWNER, bio: "", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0005", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store, auto: boolean): Promise<void> {
  redis.clear();
  created.length = 0;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff: "aaaaaaaaaaaa", at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })],
    ["SET", `nl:store:owner:${OWNER}`, JSON.stringify(store)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
  await setAutoPay(store, auto);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const linkRead = (c: Commands) => c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:pp:${STATS}`;
const at13 = (day: number) => new Date(Date.UTC(2026, 10, day, 13, 0, 0));
const claimKey = `nl:aff:payday:${STATS}:2026-11`;
const claimed = async () => (await real([["GET", claimKey]]))[0];
const UNREAD = "could not read your PayPal connection";

/** Rewrites the stored link's auto-pay switch, the sealed Secret left as it is. */
async function storedAuto(value: unknown): Promise<void> {
  const [raw] = await real([["GET", `nl:pp:${STATS}`]]);
  const link = JSON.parse(String(raw)) as Record<string, unknown>;
  link.auto = value;
  await real([["SET", `nl:pp:${STATS}`, JSON.stringify(link)]]);
}

/**
 * Payday with the link unreadable, then the healthy runs the real schedule
 * makes. The email itself cannot be watched here (the test sender is blocked
 * without a reviewed Resend binding), so the run is read by what it leaves:
 * not failed, the month claimed, nothing sent to PayPal. The auto-pay path
 * would read the link again inside payWithPayPal and fail; only the reminder
 * path claims the month and stops there.
 */
async function month(broken: () => Promise<{ due: number; failed: number }>): Promise<void> {
  const first = await broken();
  is("payday: the store is due and does not fail", [first.due, first.failed], [1, 0]);
  is("payday: nothing is sent to PayPal", created.length, 0);
  is("payday: the month is claimed on that very run", await claimed(), "1");
  for (const day of [6, 7, 15, 30]) await sendPaydayEmails(Date.now() + 60_000, at13(day));
  const again = await sendPaydayEmails(Date.now() + 60_000, at13(5));
  is("the rest of the month and a second payday run: no batch, nothing failed", [created.length, again.failed], [0, 0]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_unread_link_only";
  process.env.RESEND_API_KEY = "re_test_unread_link_only";
  console.error = () => {};
  const store = shop();

  for (const [label, reply] of [
    ["a number", [42]],
    ["undefined", [undefined]],
    ["no reply at all", []],
    ["unreadable JSON", ["{"]],
  ] as [string, unknown[]][]) {
    part(`Auto-pay on, the link answers ${label} on payday`);
    await seed(store, true);
    await month(async () => {
      redis.pipeline = (async (c: Commands) => (linkRead(c) ? [...reply] : real(c))) as typeof redis.pipeline;
      try {
        return await sendPaydayEmails(Date.now() + 60_000, at13(5));
      } finally {
        redis.pipeline = real;
      }
    });
  }

  for (const [label, value] of [['the string "false"', "false"], ['the string "true"', "true"], ["the number 1", 1], ["null", null]] as [string, unknown][]) {
    part(`The link's auto-pay switch is stored as ${label}`);
    await seed(store, true);
    await storedAuto(value);
    await month(() => sendPaydayEmails(Date.now() + 60_000, at13(5)));
  }

  part("Control: auto-pay on, healthy: one PayPal batch on payday, nothing after");
  await seed(store, true);
  await sendPaydayEmails(Date.now() + 60_000, at13(5));
  for (const day of [6, 7, 15, 30]) await sendPaydayEmails(Date.now() + 60_000, at13(day));
  is("one batch, the month claimed", [created.length, await claimed()], [1, "1"]);

  part("Control: auto-pay off: no batch, the month claimed for the reminder");
  await seed(store, false);
  const off = await sendPaydayEmails(Date.now() + 60_000, at13(5));
  is("no batch, nothing failed, claimed", [created.length, off.failed, await claimed()], [0, 0, "1"]);

  part("The reminder says the connection could not be read, only when it could not");
  const base = { storeName: "Harbor Kitchen", payday: 5, people: 1, totalCents: 3000, currency: "usd", waitingCents: 0, hold: 0, refundsChecked: true };
  const unread = paydayEmail({ ...base, linkUnread: true });
  is("it says so, and that nothing left their PayPal", [unread.text.includes(UNREAD), unread.text.includes("Nothing left your PayPal")], [true, true]);
  is("it is still the reminder with the amount to pay", unread.subject, "$30 to pay your affiliates today");
  is("a healthy reminder never says it", paydayEmail(base).text.includes(UNREAD), false);
  done();
}

void main();
