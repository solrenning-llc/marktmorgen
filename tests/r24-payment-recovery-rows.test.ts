/**
 * CX-123 rule 24 on the rows Stripe answers to the daily payment emails
 * (lib/payment-recovery.ts), as cameBack and the recovery report already read
 * theirs (a partial row is unknown, Codex N on #2714):
 *
 *   - a failed renewal's invoice says when Stripe tries the card again
 *     (`next_payment_attempt`: a time, or null for never) and in what currency
 *     the money is owed. Missing or of another shape, the email would tell the
 *     member "the card on file won't be tried again" and price the payment in
 *     the store's currency, both guessed. Nothing is sent, claimed or changed
 *     at Stripe on such a row; the email goes on the next whole row;
 *   - a running membership says whether it is ending or paused
 *     (`cancel_at_period_end`, `cancel_at`, `pause_collection`, each null or
 *     false when not). Missing or of another shape, it was read as "running,
 *     with a payment ahead", and a member with no payment ahead could be told
 *     their card stops working before it. No notice goes on such a row.
 *
 * The healthy rows (null for never, a time, false and null for running) send
 * exactly as before. Synthetic store, Stripe and email stand-ins only.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
/** Memberships told to keep the card that pays (the POST before a first email). */
const saved: string[] = [];
const state = { pastDue: [] as Record<string, unknown>[], active: [] as Record<string, unknown>[] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as Mail);
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    const status = url.searchParams.get("status");
    return answer({ object: "list", data: status === "past_due" ? state.pastDue : status === "active" ? state.active : [], has_more: false });
  }
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") {
    saved.push(path.split("/").pop() as string);
    return answer({ id: path.split("/").pop() });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const to = (who: string) => mails.filter((m) => [m.to].flat().includes(who));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();
  const OWNER = "r24-rows@example.com";
  await claimHandle(OWNER, "rtfrows", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRtfRows01", true);
  await setSubscription(OWNER, { customerId: "cus_RtfRows0001", subscriptionId: "sub_RtfRows0001", active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setDunning(OWNER, { reminders: 1, cardNotice: true });
  await storeForEmail(OWNER);
  const run = () => recoverFailedPayments(Date.now() + 20_000);
  const meta = { store: "rtfrows", product: club.product.id };
  const markOf = (invoice: string) => redis.pipeline([["GET", `nl:dun:acct_1TestRtfRows01:${invoice}`]]).then((r) => r[0]);

  part("A failed renewal: the email is sent only on a whole invoice");
  const failing = (n: string, invoice: Record<string, unknown>) => ({
    id: `sub_RtfFail${n}`, status: "past_due", metadata: meta,
    customer: { id: `cus_RtfFail${n}`, email: `fail${n}@example.com` },
    latest_invoice: { id: `in_RtfFail${n}`, status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/f${n}`, next_payment_attempt: null, ...invoice },
  });
  const odd: [string, string, Record<string, unknown>][] = [
    ["0001", "no next_payment_attempt", { next_payment_attempt: undefined }],
    ["0002", "next_payment_attempt as text", { next_payment_attempt: "1893456000" }],
    ["0003", "next_payment_attempt as an object", { next_payment_attempt: {} }],
    ["0004", "no currency", { currency: undefined }],
    ["0005", "currency as a number", { currency: 840 }],
    ["0006", "currency as an empty word", { currency: "" }],
  ];
  state.pastDue = odd.map(([n, , invoice]) => failing(n, invoice));
  await run();
  for (const [n, what] of odd) {
    is(`${what}: no email, no claim, nothing changed at Stripe`, [to(`fail${n}@example.com`).length, await markOf(`in_RtfFail${n}`), saved.includes(`sub_RtfFail${n}`)], [0, null, false]);
  }

  part("Healthy invoices send exactly as before");
  const later = Math.floor(Date.UTC(2030, 2, 14, 12) / 1000);
  state.pastDue = [
    failing("0007", { next_payment_attempt: null }),
    failing("0008", { next_payment_attempt: later }),
    failing("0009", { next_payment_attempt: 0 }),
  ];
  await run();
  is("null (no retry): sent once, and says the card won't be tried again", [to("fail0007@example.com").length, to("fail0007@example.com")[0]?.text.includes("won't be tried again")], [1, true]);
  is("a time: sent once, with the day it is tried again", [to("fail0008@example.com").length, to("fail0008@example.com")[0]?.text.includes("March 14")], [1, true]);
  is("0, as before: sent once", to("fail0009@example.com").length, 1);
  is("each kept the card that pays", ["0007", "0008", "0009"].map((n) => saved.includes(`sub_RtfFail${n}`)), [true, true, true]);

  part("An odd row made whole goes on the next run, once");
  state.pastDue = odd.map(([n]) => failing(n, {}));
  await run();
  await run();
  is("every one now sent once", odd.map(([n]) => to(`fail${n}@example.com`).length), odd.map(() => 1));
  state.pastDue = [];

  part("A card that stops working: no notice on a row that does not say it is running");
  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  const running = (n: string, extra: Record<string, unknown>) => ({
    id: `sub_RtfRun${n}`, status: "active", metadata: meta,
    cancel_at_period_end: false, cancel_at: null, pause_collection: null,
    customer: { id: `cus_RtfRun${n}`, email: `run${n}@example.com`, invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: `pm_RtfOld${n}`, type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
    ...extra,
  });
  const notRunning: [string, string, Record<string, unknown>][] = [
    ["0001", "no pause_collection", { pause_collection: undefined }],
    ["0002", "pause_collection as text", { pause_collection: "void" }],
    ["0003", "no cancel_at", { cancel_at: undefined }],
    ["0004", "cancel_at as text", { cancel_at: "1893456000" }],
    ["0005", "no cancel_at_period_end", { cancel_at_period_end: undefined }],
    ["0006", "cancel_at_period_end as text", { cancel_at_period_end: "false" }],
  ];
  state.active = notRunning.map(([n, , extra]) => running(n, extra));
  await run();
  for (const [n, what] of notRunning) is(`${what}: no notice`, to(`run${n}@example.com`).length, 0);

  part("Running, ending and paused rows read as before");
  state.active = [
    running("0007", {}),
    running("0008", { cancel_at_period_end: true }),
    running("0009", { cancel_at: payAt }),
    running("0010", { pause_collection: { behavior: "void", resumes_at: payAt + 30 * 86_400 } }),
  ];
  await run();
  await run();
  is("running: told once", to("run0007@example.com").length, 1);
  is("ending or paused: not told", ["0008", "0009", "0010"].map((n) => to(`run${n}@example.com`).length), [0, 0, 0]);
  state.active = notRunning.map(([n]) => running(n, {}));
  await run();
  is("the odd rows made whole: each told once", notRunning.map(([n]) => to(`run${n}@example.com`).length), notRunning.map(() => 1));
  done();
}

void main();
