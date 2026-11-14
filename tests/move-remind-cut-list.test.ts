/**
 * Claude 4's LEVE on #3598 (6777085706): keptAlready (lib/move-members.ts) throws on a Stripe list that is cut short,
 * so an unknown answer is never read as "not kept" (rule 24). For an address with more customer records than are read,
 * that cut is a stable state, not a passing failure: sendMoveReminders (lib/imports.ts) put the reminder back an hour
 * every time, for ever, with one Stripe read each time and never an email. It may be tried again only while a reminder
 * could still go, that is before the renewal date; after it, the entry is dropped.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { redisPipeline, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000);
const noon = (d: Date) => Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12) / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

let cut = false;
let customerReads = 0;
let emails = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as unknown;
    emails += Array.isArray(body) ? body.length : 1;
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/customers" && method === "GET") {
    customerReads += 1;
    // Ten guest checkouts each made a customer record, and more lie beyond the page.
    const data = cut ? Array.from({ length: 10 }, (_, n) => ({ id: `cus_Guest0000${n}` })) : [];
    return new Response(JSON.stringify({ object: "list", data, has_more: cut }));
  }
  if (path === "/subscriptions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function waiting(): Promise<number> {
  const [n] = await redisPipeline([["ZCARD", "nl:mv:due"]]);
  return Number(n);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_cut_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_cut_only_a_stand_in";
  redis.clear();
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 7, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;
  const in20 = noon(new Date((nowS + 20 * DAY) * 1000));
  const started = await startImport(store, OWNER, "members", { expected: 1, file: "patrons.csv", stopped: true });
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  await addRows(store, started.job.id, [["2", "ada@example.com", "The Inner Circle", iso(in20), ""]]);
  await finishUpload(store, started.job.id);
  for (let i = 0; i < 6; i += 1) await runImport(started.job.id, Date.now() + 30_000);
  // Only the reminder matters here; the first email's own pacing is tested in move-members.test.ts.
  is("Ada is invited, and her reminder waits", await waiting(), 1);
  const base = emails;

  part("Before the renewal date: unknown, so put back and tried again, never sent");
  cut = true;
  const first = await sendMoveReminders(Date.now() + 30_000, (in20 - 3 * DAY + 3_600) * 1000);
  is("no reminder to someone who may have kept it", first.sent, 0);
  is("and no email", emails, base);
  is("still waiting, for the next hour", await waiting(), 1);

  part("After the renewal date: no reminder can go, so the entry is dropped, not read for ever");
  const after = await sendMoveReminders(Date.now() + 30_000, (in20 + 30 * DAY) * 1000);
  is("nothing sent", [after.sent, emails], [0, base]);
  is("nothing left waiting", await waiting(), 0);
  const reads = customerReads;
  await sendMoveReminders(Date.now() + 30_000, (in20 + 365 * DAY) * 1000);
  is("and Stripe is not asked again a year later", customerReads, reads);

  done();
}

void main();
