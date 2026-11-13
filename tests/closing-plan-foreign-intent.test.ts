/**
 * #4423 (Codex X8, transcribed by Claude 2): undoing a plan bought for a
 * closing store reads the plan payment's PaymentIntent with its charge, and
 * sizes the refund from that charge. An answer for another payment (another
 * PaymentIntent's id, or a charge that names another payment) decides
 * nothing: no refund is asked for, the task stays in line, and the creator is
 * not told money came back. A charge expanded with no payment_intent is read
 * as before. Synthetic Stripe and email stand-ins only.
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
  /** A payment whose read answers for another payment (#4423): the reply given instead. */
  foreign: new Map<string, unknown>(),
};
const sent: { to: string; subject: string; text: string }[] = [];

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
    return json({ object: "list", data: world.invoices.filter((row) => row.subscription === url.searchParams.get("subscription")), has_more: false });
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
    if (world.foreign.has(intent[1])) return json(world.foreign.get(intent[1]));
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

/** An invoice's payment as Stripe lists it at the current API version. */
const paidPart = (invoice: string, intent: string, amount: number, paidAt: number): Payment => ({
  id: `inpay_${intent.slice(3)}`,
  object: "invoice_payment",
  invoice,
  status: "paid",
  amount_paid: amount,
  amount_requested: amount,
  payment: { type: "payment_intent", payment_intent: intent },
  status_transitions: { paid_at: paidAt, canceled_at: null },
});
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
  const posts = () => world.refunds.map((row) => row.payment_intent);
  const charge = (pi: string, amount: number, extra: Record<string, unknown> = {}) => ({ id: `ch_${pi.slice(3)}`, currency: "usd", amount, amount_refunded: 0, disputed: false, ...extra });

  part("Control: the plan payment's own answer is refunded in full");
  {
    const one = await inLine("ownpi01", [invoiceRow("in_ownpi01", "paid", 4_000, { payment_intent: "pi_ownpi01" })]);
    world.payments.set("in_ownpi01", [paidPart("in_ownpi01", "pi_ownpi01", 4_000, S(day) + 120)]);
    world.charges.set("pi_ownpi01", 4_000);
    is("settled", await settleOne(one.id), true);
    is("$40 back on its own payment", refundsOf("pi_ownpi01"), [4_000]);
  }

  part("The read of payment A answers for payment B");
  for (const [name, answer] of [
    ["another id, B unrefunded", (a: string) => ({ id: "pi_foreignb", latest_charge: charge("pi_foreignb", 12_000) })],
    ["another id, B already refunded", (a: string) => ({ id: "pi_foreignb", latest_charge: charge("pi_foreignb", 12_000, { amount_refunded: 12_000 }) })],
    ["its own id, a charge naming B", (a: string) => ({ id: a, latest_charge: charge("pi_foreignb", 12_000, { payment_intent: "pi_foreignb" }) })],
    ["no id at all", (a: string) => ({ latest_charge: charge(a, 4_000) })],
  ] as [string, (a: string) => unknown][]) {
    const tag = `foreignpay0${world.subs.size}`;
    const a = `pi_${tag}`;
    const one = await inLine(tag, [invoiceRow(`in_${tag}`, "paid", 4_000, { payment_intent: a })]);
    world.payments.set(`in_${tag}`, [paidPart(`in_${tag}`, a, 4_000, S(day) + 120)]);
    world.charges.set(a, 4_000);
    world.foreign.set(a, answer(a));
    // B refunded in full on its own charge: its refunds list says so.
    if (name.includes("already refunded") && !world.refunds.some((row) => row.charge === "ch_foreignb")) {
      world.refunds.push({ id: "re_foreignb01", charge: "ch_foreignb", payment_intent: "pi_foreignb", amount: 12_000, status: "succeeded", key: "" });
    }
    const before = posts().length;
    is(`${name}: not settled`, await settleOne(one.id).catch(() => false), false);
    is(`${name}: no refund is asked for`, posts().length, before);
    is(`${name}: still in line, not done`, await settledOf(one.id), false);
    is(`${name}: the creator is not told money came back`, lettersTo(one.to).length, 0);
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
