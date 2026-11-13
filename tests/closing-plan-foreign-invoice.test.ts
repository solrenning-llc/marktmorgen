/**
 * The closing-plan guard (lib/closing-plan-guard.ts, settleOne) lists the invoices of the plan to undo with
 * `subscription=<id>` and gives back the money on each, voiding the unpaid ones. Its row check (invoiceKnown) never
 * read the row's own `subscription`, so a reply carrying another subscription's invoice (rule 30: an answer that is not
 * the one asked for) had that invoice's payment refunded in full and an open one voided: real money given back on a
 * payment nobody asked to undo. Found by Claude 3 (nuvem E)'s money audit of main, 13/11/2026.
 *
 * Synthetic: stand-ins for our Stripe account and the email sender; every id is made up.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { UNDO_KEY, settleOne } from "@/lib/closing-plan-guard";
import { redisPipeline } from "@/lib/redis";

const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;
const day = Date.UTC(2026, 11, 2);

/** An invoice as listed, before the stand-in names its subscription. */
type InvoiceRow = Record<string, unknown> & { id: string; status: string };
type Invoice = InvoiceRow & { subscription: string };
type Payment = Record<string, unknown>;
type Refund = { id: string; charge: string; payment_intent: string; amount: number; status: string; key: string };

const world = {
  subs: new Map<string, { id: string; status: string; created: number }>(),
  invoices: [] as Invoice[],
  /** Each invoice's payments, as GET /v1/invoice_payments?invoice= lists them; a function answers a garbled page. */
  payments: new Map<string, Payment[] | (() => unknown)>(),
  charges: new Map<string, number>(),
  refunds: [] as Refund[],
  voids: [] as string[],
  deletes: [] as string[],
  paymentReads: [] as string[],
};
const sent: { to: string; subject: string; text: string }[] = [];
/** When set, the invoice list answers rows of every subscription, not only the one asked for (a reply not its own). */
let leak = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text?: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text ?? "" });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const key = new Headers(init?.headers).get("idempotency-key") ?? "";
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(String(init?.body ?? ""));

  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub) {
    const row = world.subs.get(sub[1]);
    if (!row) return json({ error: { message: "No such subscription" } }, 404);
    if (method === "DELETE") {
      if (row.status === "canceled") return json({ error: { message: "already canceled" } }, 400);
      row.status = "canceled";
    }
    return json({ ...row, object: "subscription" });
  }
  if (path === "/invoices" && method === "GET") {
    return json({ object: "list", data: leak ? world.invoices : world.invoices.filter((row) => row.subscription === url.searchParams.get("subscription")), has_more: false });
  }
  const voided = path.match(/^\/invoices\/(in_\w+)\/void$/);
  if (voided) {
    world.voids.push(voided[1]);
    const row = world.invoices.find((one) => one.id === voided[1]);
    // As Stripe does: an invoice with open or paid payments cannot be voided.
    if (!row || (row.amount_paid as number) > 0) return json({ error: { type: "invalid_request_error", message: "This invoice has payments and cannot be voided." } }, 400);
    row.status = "void";
    return json({ id: voided[1], status: "void" });
  }
  const deleted = path.match(/^\/invoices\/(in_\w+)$/);
  if (deleted && method === "DELETE") {
    world.deletes.push(deleted[1]);
    world.invoices = world.invoices.filter((one) => one.id !== deleted[1]);
    return json({ id: deleted[1], deleted: true });
  }
  if (path === "/invoice_payments" && method === "GET") {
    const invoice = String(url.searchParams.get("invoice"));
    world.paymentReads.push(invoice);
    const rows = world.payments.get(invoice);
    if (typeof rows === "function") return json(rows());
    return json({ object: "list", data: rows ?? [], has_more: false });
  }
  const intent = path.match(/^\/payment_intents\/(pi_\w+)$/);
  if (intent) {
    const amount = world.charges.get(intent[1]);
    if (!amount) return json({ error: { message: "No such payment_intent" } }, 404);
    const refunded = world.refunds.filter((row) => row.payment_intent === intent[1] && row.status === "succeeded").reduce((sum, row) => sum + row.amount, 0);
    return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, currency: "usd", amount, amount_refunded: refunded, disputed: false } });
  }
  if (path === "/refunds" && method === "GET") return json({ object: "list", data: world.refunds.filter((row) => row.charge === url.searchParams.get("charge")), has_more: false });
  if (path === "/refunds" && method === "POST") {
    const pi = String(form.get("payment_intent"));
    const kept = world.refunds.find((row) => row.key === key);
    if (kept) return json(kept);
    const refund: Refund = { id: `re_${String(world.refunds.length + 1).padStart(8, "0")}`, charge: `ch_${pi.slice(3)}`, payment_intent: pi, amount: Number(form.get("amount")), status: "succeeded", key };
    world.refunds.push(refund);
    return json(refund);
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A plan started after the store's last plan ended, in line to be undone, with these invoices. */
async function inLine(name: string, invoices: InvoiceRow[]) {
  const id = `sub_${name}`;
  world.subs.set(id, { id, status: "active", created: S(day) - 3_600 });
  for (const invoice of invoices) world.invoices.push({ ...invoice, subscription: id });
  const to = `${name}@example.com`;
  await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify({ h: name, c: "", to, name: "Partial Shop", since: day, ended: day - 30 * DAY, at: day, n: 0 })]]);
  return { id, to };
}

const invoiceRow = (id: string, status: string, amountPaid: unknown, extra: Record<string, unknown> = {}): InvoiceRow => ({
  id,
  status,
  amount_paid: amountPaid,
  created: S(day) + 60,
  payment_intent: null,
  status_transitions: { paid_at: status === "paid" ? S(day) + 300 : null },
  ...extra,
});
const refundsOf = (pi: string) => world.refunds.filter((row) => row.payment_intent === pi).map((row) => row.amount);
const settledOf = async (id: string) => {
  const [raw] = await redisPipeline([["HGET", UNDO_KEY, id]]);
  return typeof raw === "string" && typeof (JSON.parse(raw) as { done?: unknown }).done === "number";
};
const lettersTo = (to: string) => sent.filter((m) => m.to === to);

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const quiet = console.error;
  console.error = () => {};

  part("A list that also answers another subscription's invoices");
  // Another store's plan, paid and with an open invoice, never in line to be undone.
  const other = "sub_otherplan01";
  world.subs.set(other, { id: other, status: "active", created: S(day) - 3_600 });
  world.invoices.push({ ...invoiceRow("in_otherpaid01", "paid", 4_900, { payment_intent: "pi_otherpaid01" }), subscription: other });
  world.invoices.push({ ...invoiceRow("in_otheropen01", "open", 0), subscription: other });
  world.charges.set("pi_otherpaid01", 4_900);
  const one = await inLine("ownplan01", [invoiceRow("in_ownplan01", "paid", 6_900, { payment_intent: "pi_ownplan01" })]);
  world.charges.set("pi_ownplan01", 6_900);
  leak = true;
  const settled = await settleOne(one.id);
  leak = false;
  is("nothing of the other subscription is refunded", refundsOf("pi_otherpaid01"), []);
  is("nothing of the other subscription is voided", world.voids.includes("in_otheropen01"), false);
  is("the plan is kept in line, not settled on a reply that is not its own", [settled, await settledOf(one.id)], [false, false]);
  is("no letter is written on it", lettersTo(one.to).length, 0);

  part("Control: the plan's own list is given back as before");
  is("settled", await settleOne(one.id), true);
  is("its own payment is given back in full, once", refundsOf("pi_ownplan01"), [6_900]);

  console.error = quiet;
  done();
}

void main();
