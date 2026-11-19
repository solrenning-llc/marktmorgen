/**
 * A plan bought for a closing store whose invoice holds money although it is
 * not `paid` (queue item 307 [EC1], held to item 569 [NC1] and CX-123 rule 24),
 * against a stand-in for our own Stripe account and the email sender. Nothing
 * real is reached; every id is synthetic.
 *
 * Stripe lets an invoice be paid in parts: each payment is an InvoicePayment,
 * `amount_paid` and `amount_remaining` move with it, and the invoice is `paid`
 * only once nothing remains. With `open` or `paid` payments on it, Stripe does
 * not void it; with only `paid` ones it can still be marked uncollectible
 * (docs.stripe.com/invoicing/partial-payments, "Accept partial payments for
 * invoices", read 08/11/2026). So money can sit on an `open` or an
 * `uncollectible` invoice, and on a `paid` one in more than one payment.
 *
 * What fails here:
 *   - money taken on a plan's invoice that is not given back, in full, because
 *     the invoice is open, uncollectible or paid in more than one payment;
 *   - a letter that says "No payment was taken" when one was;
 *   - an invoice whose payments or amount do not read exactly (rule 24) that is
 *     settled, voided, refunded on a guess or written to the creator about;
 *   - a fully unpaid invoice no longer voided or deleted as before, or a plain
 *     paid one refunded any other way than before.
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
    const amount = world.charges.get(intent[1]);
    if (!amount) return json({ error: { message: "No such payment_intent" } }, 404);
    const refunded = world.refunds.filter((row) => row.payment_intent === intent[1] && row.status === "succeeded").reduce((sum, row) => sum + row.amount, 0);
    return json({ id: intent[1], latest_charge: { id: `ch_${intent[1].slice(3)}`, payment_intent: intent[1], currency: "usd", amount, amount_refunded: refunded, disputed: false } });
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

  part("Money on an uncollectible invoice (paid in part, then marked uncollectible)");
  {
    const one = await inLine("uncpart01", [invoiceRow("in_uncpart01", "uncollectible", 3_000)]);
    world.payments.set("in_uncpart01", [paidPart("in_uncpart01", "pi_uncpart01", 3_000, S(day) + 120), { id: "inpay_uncfail01", object: "invoice_payment", invoice: "in_uncpart01", status: "canceled", amount_paid: null, payment: { type: "payment_intent", payment_intent: "pi_uncfail01" }, status_transitions: { paid_at: null, canceled_at: S(day) + 90 } }]);
    world.charges.set("pi_uncpart01", 3_000);
    is("settled", await settleOne(one.id), true);
    is("the $30 taken is given back in full, once", refundsOf("pi_uncpart01"), [3_000]);
    const told = lettersTo(one.to);
    is("the creator is told once that the payment was returned", [told.length, told[0]?.subject, told[0]?.text.includes("$30 in full")], [1, "Partial Shop: your plan payment was returned", true]);
    is("the letter never says no payment was taken", told.some((m) => m.text.includes("No payment was taken")), false);
    is("a recheck asks for no second refund and writes no second letter", [await settleOne(one.id, true), refundsOf("pi_uncpart01"), lettersTo(one.to).length], [true, [3_000], 1]);
  }

  part("Money on an open invoice (paid in part): Stripe does not void it");
  {
    const one = await inLine("openpart01", [invoiceRow("in_openpart01", "open", 2_000, { amount_remaining: 4_900 })]);
    world.payments.set("in_openpart01", [paidPart("in_openpart01", "pi_openpart01", 2_000, S(day) + 120)]);
    world.charges.set("pi_openpart01", 2_000);
    is("settled", await settleOne(one.id), true);
    is("the $20 taken is given back in full, once", refundsOf("pi_openpart01"), [2_000]);
    is("no void is asked for an invoice with money on it", world.voids.includes("in_openpart01"), false);
    const told = lettersTo(one.to);
    is("the creator is told once, honestly", [told.length, told[0]?.text.includes("$20 in full"), told[0]?.text.includes("No payment was taken")], [1, true, false]);
  }

  part("A paid invoice paid in two payments: both are given back");
  for (const [name, direct] of [["twopart01", "pi_twopart01a"], ["twopart02", null]] as [string, string | null][]) {
    const invoice = `in_${name}`;
    const one = await inLine(name, [invoiceRow(invoice, "paid", 6_900, { payment_intent: direct })]);
    world.payments.set(invoice, [paidPart(invoice, `pi_${name}a`, 3_000, S(day) + 120), paidPart(invoice, `pi_${name}b`, 3_900, S(day) + 300)]);
    world.charges.set(`pi_${name}a`, 3_000);
    world.charges.set(`pi_${name}b`, 3_900);
    const label = direct ? "the invoice naming the first" : "the invoice naming none";
    is(`${label}: settled`, await settleOne(one.id), true);
    is(`${label}: each payment is given back in full, once`, [refundsOf(`pi_${name}a`), refundsOf(`pi_${name}b`)], [[3_000], [3_900]]);
    is(`${label}: the letter says $69 was returned`, lettersTo(one.to).map((m) => m.text.includes("$69 in full")), [true]);
    is(`${label}: a recheck changes nothing`, [await settleOne(one.id, true), refundsOf(`pi_${name}a`), refundsOf(`pi_${name}b`), lettersTo(one.to).length], [true, [3_000], [3_900], 1]);
  }

  part("Rule 24: an invoice that may hold money and does not read exactly is never settled");
  const garbled: [string, InvoiceRow, (Payment[] | (() => unknown))?][] = [
    ["an uncollectible invoice with no amount_paid", (() => { const row = invoiceRow("in_unkn01", "uncollectible", 0); delete row.amount_paid; return row; })()],
    ["an uncollectible invoice with amount_paid as text", invoiceRow("in_unkn02", "uncollectible", "3000")],
    ["an open invoice with amount_paid below zero", invoiceRow("in_unkn03", "open", -1)],
    ["an open invoice with amount_paid null", invoiceRow("in_unkn04", "open", null)],
    ["an uncollectible invoice with money and no created", invoiceRow("in_unkn05", "uncollectible", 3_000, { created: null })],
    ["a paid payment that is a charge, not a payment intent", invoiceRow("in_unkn06", "uncollectible", 3_000), [{ ...paidPart("in_unkn06", "pi_unkn06", 3_000, S(day) + 120), payment: { type: "charge", charge: "ch_unkn06" } }]],
    ["payments with more pages and no row to read them from", invoiceRow("in_unkn07", "uncollectible", 3_000), () => ({ object: "list", data: [], has_more: true })],
    ["payments that are not a list", invoiceRow("in_unkn08", "uncollectible", 3_000), () => ({ object: "list", data: "none", has_more: false })],
    ["paid payments that add up to less than was paid", invoiceRow("in_unkn09", "uncollectible", 3_000), [paidPart("in_unkn09", "pi_unkn09", 1_000, S(day) + 120)]],
    ["no paid payment listed at all", invoiceRow("in_unkn10", "open", 3_000), []],
    ["a paid payment with no paid_at", invoiceRow("in_unkn11", "uncollectible", 3_000), [{ ...paidPart("in_unkn11", "pi_unkn11", 3_000, 0), status_transitions: { paid_at: null, canceled_at: null } }]],
    ["a payment with a status Stripe does not give", invoiceRow("in_unkn12", "uncollectible", 3_000), [paidPart("in_unkn12", "pi_unkn12", 3_000, S(day) + 120), { ...paidPart("in_unkn12", "pi_unkn12x", 500, S(day) + 120), status: "transport_unknown" }]],
    ["a payment of another invoice", invoiceRow("in_unkn13", "uncollectible", 3_000), [paidPart("in_other13", "pi_unkn13", 3_000, S(day) + 120)]],
    ["a paid payment with amount_paid as text", invoiceRow("in_unkn14", "uncollectible", 3_000), [{ ...paidPart("in_unkn14", "pi_unkn14", 3_000, S(day) + 120), amount_paid: "3000" }]],
  ];
  for (const [index, [what, invoice, payments]] of garbled.entries()) {
    const name = `unknown${String(index).padStart(2, "0")}`;
    const one = await inLine(name, [invoice]);
    if (payments) world.payments.set(invoice.id, payments);
    for (const row of Array.isArray(payments) ? payments : []) {
      const pi = (row.payment as { payment_intent?: unknown } | undefined)?.payment_intent;
      if (typeof pi === "string") world.charges.set(pi, Number(row.amount_paid) || 3_000);
    }
    const posts = world.refunds.length;
    is(`${what}: kept in line, nothing refunded on a guess, not voided, nobody told`, [await settleOne(one.id), await settledOf(one.id), world.refunds.length - posts, world.voids.includes(invoice.id), lettersTo(one.to).length], [false, false, 0, false, 0]);
  }

  part("A payment still being processed: what was paid is returned, and it waits for the rest");
  {
    const one = await inLine("pending01", [invoiceRow("in_pending01", "open", 2_000)]);
    world.payments.set("in_pending01", [paidPart("in_pending01", "pi_pending01", 2_000, S(day) + 120), { id: "inpay_pending01b", object: "invoice_payment", invoice: "in_pending01", status: "open", amount_paid: null, payment: { type: "payment_intent", payment_intent: "pi_pending01b" }, status_transitions: { paid_at: null, canceled_at: null } }]);
    world.charges.set("pi_pending01", 2_000);
    is("not settled while a payment of it may still come", [await settleOne(one.id), await settledOf(one.id), lettersTo(one.to).length], [false, false, 0]);
    is("what was paid is given back already", refundsOf("pi_pending01"), [2_000]);
    world.payments.set("in_pending01", [paidPart("in_pending01", "pi_pending01", 2_000, S(day) + 120), { id: "inpay_pending01b", object: "invoice_payment", invoice: "in_pending01", status: "canceled", amount_paid: null, payment: { type: "payment_intent", payment_intent: "pi_pending01b" }, status_transitions: { paid_at: null, canceled_at: S(day) + 900 } }]);
    is("once it failed: settled, no second refund, one honest letter", [await settleOne(one.id), refundsOf("pi_pending01"), lettersTo(one.to).map((m) => m.text.includes("$20 in full"))], [true, [2_000], [true]]);
  }

  part("Controls: unchanged");
  {
    const reads = world.paymentReads.length;
    const one = await inLine("unpaid01", [invoiceRow("in_unpaid01o", "open", 0), invoiceRow("in_unpaid01d", "draft", 0), invoiceRow("in_unpaid01u", "uncollectible", 0), invoiceRow("in_unpaid01v", "void", 0)]);
    is("fully unpaid: settled", await settleOne(one.id), true);
    is("its open invoice is voided and its draft deleted, the others left as they are", [world.voids.filter((id) => id.startsWith("in_unpaid01")), world.deletes, world.invoices.filter((row) => row.subscription === one.id).map((row) => [row.id, row.status])], [["in_unpaid01o"], ["in_unpaid01d"], [["in_unpaid01o", "void"], ["in_unpaid01u", "uncollectible"], ["in_unpaid01v", "void"]]]);
    is("the letter says no payment was taken", lettersTo(one.to).map((m) => m.text.includes("No payment was taken for it.")), [true]);
    is("no invoice's payments are read for it", world.paymentReads.length - reads, 0);
  }
  {
    const reads = world.paymentReads.length;
    const one = await inLine("plain01", [invoiceRow("in_plain01", "paid", 6_900, { payment_intent: "pi_plain01" })]);
    world.charges.set("pi_plain01", 6_900);
    is("a plain paid invoice: settled", await settleOne(one.id), true);
    is("refunded in full once, under the same key as before", world.refunds.filter((row) => row.payment_intent === "pi_plain01").map((row) => [row.amount, row.key]), [[6_900, "closing-plan-refund:in_plain01:0"]]);
    is("its payments are not read", world.paymentReads.length - reads, 0);
    is("one letter, $69 returned", lettersTo(one.to).map((m) => m.text.includes("$69 in full")), [true]);
  }
  {
    // The store's own plan from before its last plan ended, paid in part before the closing day began: a payment for a
    // plan it had, never refunded, and no letter (as for a paid one before the day).
    const id = "sub_ownpart01";
    world.subs.set(id, { id, status: "active", created: S(day) - 90 * 86_400 });
    world.invoices.push({ ...invoiceRow("in_ownpart01", "uncollectible", 3_000, { created: S(day) - 40 * 86_400 }), subscription: id });
    world.payments.set("in_ownpart01", [paidPart("in_ownpart01", "pi_ownpart01", 3_000, S(day) - 40 * 86_400)]);
    world.charges.set("pi_ownpart01", 3_000);
    await redisPipeline([["HSET", UNDO_KEY, id, JSON.stringify({ h: "ownpart01", c: "", to: "ownpart01@example.com", name: "Own Shop", since: day, ended: day - 30 * DAY, at: day, n: 0 })]]);
    is("the store's own plan paid in part before the day: settled, nothing refunded, nobody told", [await settleOne(id), refundsOf("pi_ownpart01"), lettersTo("ownpart01@example.com").length], [true, [], 0]);
  }

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
