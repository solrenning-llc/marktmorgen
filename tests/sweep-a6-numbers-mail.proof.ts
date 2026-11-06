/**
 * Proof (sweep A6, CX-123 rule 24/30): marks that decide an email or a post
 * are read loosely in lib/stats-report.ts and lib/sale-events.ts, while their
 * siblings in lib/store-alerts.ts and noteOfferSale use the exact claimMark.
 *
 *   - weeklyOff: `Number(member) === 1`: a SISMEMBER reply of another shape is
 *     "not stopped", so checkAlerts (and the weekly, monthly, quiet-sales and
 *     busy-day emails) write to a creator who pressed the stop link;
 *   - claimWeek: `ok !== null`: a SET NX reply of another shape is "ours", so
 *     the week's email can go twice (claimMonth and the busy-day claim alike);
 *   - noteSales: `Number(marks[i]) === 1`: an EXISTS reply of another shape is
 *     "not told yet", so a sale already told is posted to the chat again.
 *
 * The "defect" tests assert the fail-closed behavior and FAIL ON PURPOSE on
 * main; each "control" passes. Synthetic records, a stand-in Stripe, Slack
 * and Resend answered here, and the in-memory Redis: nothing real is sent.
 */
// The synthetic keys tests/resend-fixture-credentials.ts already knows (those of tests/store-alerts.test.ts).
process.env.STRIPE_SECRET_KEY = "sk_test_store_alerts_stand_in";
process.env.RESEND_API_KEY = "re_test_store_alerts_stand_in";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkAlerts } from "@/lib/store-alerts";
import { setChatAddress } from "@/lib/chat-summary";
import { setSalesGoal } from "@/lib/sales-goal";
import { claimWeek, setWeeklyOff } from "@/lib/stats-report";
import { noteSales } from "@/lib/sale-events";
import { claimHandle, ensureStatsId, setChatSales, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
const DAY = 86_400_000;
const posted: string[] = [];
const emails: string[] = [];
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return json({ id: `email_${emails.length}` });
  }
  if (url.pathname.replace(/^\/v1/, "") === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** Answers [] (no slot) to a one-command pipeline whose command is `command`. */
async function withWrong<T>(command: string, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length > 0 && commands.every((c) => c[0] === command) ? [] : original.call(redis, commands)) as typeof redis.pipeline;
  try { return await run(); } finally { redis.pipeline = original; }
}

const paid = (id: string, cents: number) => ({
  id, status: "complete", payment_status: "paid", amount_total: cents, currency: "usd",
  created: Math.floor(Date.now() / 1000),
  customer_details: { email: "buyer@example.com", name: "Pat Buyer" },
  metadata: { store: "harbor", product: "nope", title: "Weeknight Club", channel: "instagram" },
});

const ready = (async () => {
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const first = (await storeForEmail(OWNER))!;
  await setChatAddress(first.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  sessions = [paid("cs_test_goal0000000001", 60_000)];
  await setSalesGoal(store.statsId!, 50_000, "usd");
  await setWeeklyOff(store.handle, true);
  return store;
})();
const goalKey = (statsId: string) => `nl:alert:${statsId}:goal-reached:${new Date().toISOString().slice(0, 7)}`;

test("control: emails go while the numbers emails are on", async () => {
  const store = await ready;
  await setWeeklyOff(store.handle, false);
  emails.length = 0;
  await checkAlerts(store);
  await setWeeklyOff(store.handle, true);
  await redis.pipeline([["DEL", goalKey(store.statsId!)]]);
  assert.equal(emails.length, 1);
});

test("control: with the numbers emails stopped, the reached goal is said in the chat and not by email", async () => {
  const store = await ready;
  emails.length = 0;
  const said = await checkAlerts(store, Date.now() + 2 * DAY);
  assert.equal(said.said, 1);
  assert.deepEqual(emails, []);
});

test("defect: a SISMEMBER reply of another shape must not email a creator who pressed stop", async () => {
  const store = await ready;
  await redis.pipeline([["DEL", goalKey(store.statsId!)]]);
  emails.length = 0;
  await withWrong("SISMEMBER", () => checkAlerts(store, Date.now() + 3 * DAY));
  assert.deepEqual(emails, [], `an email went to the stopped creator: ${JSON.stringify(emails)}`);
});

test("control: the week is claimed once", async () => {
  await ready;
  assert.equal(await claimWeek("sweep-a6-week"), true);
  assert.equal(await claimWeek("sweep-a6-week"), false);
});

test("defect: a SET NX reply of another shape must not be a claim (the week's email would go again)", async () => {
  await ready;
  assert.equal(await withWrong("SET", () => claimWeek("sweep-a6-week")), false, "claimWeek answered true on an unknown reply after the week was already claimed");
});

test("control: a sale is posted to the chat once", async () => {
  const store = await ready;
  posted.length = 0;
  await noteSales(store, [paid("cs_test_sale0000000001", 2900)]);
  await noteSales(store, [paid("cs_test_sale0000000001", 2900)]);
  assert.equal(posted.length, 1);
});

test("defect: an EXISTS reply of another shape must not post a sale already told", async () => {
  const store = await ready;
  posted.length = 0;
  const told = await withWrong("EXISTS", () => noteSales(store, [paid("cs_test_sale0000000001", 2900)]));
  assert.equal(told, 0, `the sale already told was told again (told=${told}, chat posts: ${JSON.stringify(posted)})`);
});
