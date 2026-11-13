/**
 * An invite's share (lib/creator-invite-credit.ts) is taken of what the invoice
 * kept: the amount paid less refunds and less credit notes issued after
 * payment. Stripe lists a refund made through a post-payment credit note both
 * in the credit notes' total and in the refunds, so that part is taken off
 * once (issue #4463, Codex X8). A credit note to the balance, with no refund,
 * is still taken off beside a separate refund; credit notes that cannot be
 * told apart keep the credit pending. Synthetic Stripe stand-in only.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey, byKey } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;

/*
  Every age in this file is written against INVITE_HOLD_DAYS rather than as a
  number of its own. The hold is the refund window plus a week, so when the
  refund window went from 14 days to 30 the hold went from 21 to 37 — and
  fixtures written as "35 days ago" and "invited 60 days ago" quietly swapped
  which side of the hold they were on, and which side of the invite. Said this
  way, each payment keeps the position in the story it was written to have.
*/
/** The first payment of all, also out of the hold. */
const LONG_PAST = INVITE_HOLD_DAYS + 8;
/** When the invites were accepted: before every payment above. */
const INVITED = LONG_PAST + 15;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);

type Txn = { id: string; amount: number; currency: string; metadata: Record<string, string> };
const invoices = new Map<string, Record<string, unknown>[]>();
const refunds = new Map<string, { amount: number; status: string }[]>();
const balance = new Map<string, Txn[]>();
const versions = new Set<string>();
const keys: string[] = [];
let posts = 0;
/** Each invoice's credit notes, as Stripe lists them; an invoice not here is a read that fails. */
const creditNotes = new Map<string, unknown[]>();
const note = (id: string, amount: number, refunded: number) => ({ id, object: "credit_note", type: "post_payment", status: "issued", amount, refunds: refunded ? [{ amount_refunded: refunded, refund: `re_${id}` }] : [] });

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  versions.add(headers.get("stripe-version") ?? "none");
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (process.env.DEBUG_FETCH) console.log("FETCH", method, url.pathname + url.search);
  if (method === "GET" && path === "/invoices") {
    const customer = url.searchParams.get("customer") ?? "";
    const expanded = url.searchParams.getAll("expand[]").includes("data.payments");
    const rows = (invoices.get(customer) ?? []).map((inv) => (expanded ? inv : { ...inv, payments: undefined }));
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (method === "GET" && path === "/refunds") {
    const pi = url.searchParams.get("payment_intent") ?? url.searchParams.get("charge") ?? "";
    return answer({ object: "list", data: refunds.get(pi) ?? [], has_more: false });
  }
  if (method === "GET" && path === "/credit_notes") {
    const inv = url.searchParams.get("invoice") ?? "";
    const notes = creditNotes.get(inv);
    return notes === undefined ? answer({ error: { message: "synthetic outage" } }, 500) : answer({ object: "list", data: notes, has_more: false });
  }
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") {
    return answer({ object: "list", data: [...(balance.get(txns[1]) ?? [])].reverse(), has_more: false });
  }
  if (txns && method === "POST") {
    posts += 1;
    keys.push(headers.get("idempotency-key") ?? "");
    const form = new URLSearchParams(String(init?.body ?? ""));
    const txn: Txn = {
      id: `cbtxn_${posts}abcdef`,
      amount: Number(form.get("amount")),
      currency: form.get("currency") ?? "",
      metadata: { nimbus_invite_credit: form.get("metadata[nimbus_invite_credit]") ?? "" },
    };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), txn]);
    return answer(txn);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") {
    const sum = (balance.get(customer[1]) ?? []).reduce((n, t) => n + t.amount, 0);
    return answer({ id: customer[1], object: "customer", balance: sum, currency: "usd" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid subscription invoice, as Stripe returns it from 2025 on. */
function invoice(id: string, cents: number, createdDaysAgo: number, paidDaysAgo: number, pi: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: cents,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: nowS - createdDaysAgo * DAY,
    status_transitions: { paid_at: nowS - paidDaysAgo * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: pi } }], has_more: false },
    ...extra,
  };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const cal = await made("cal@example.com", "cal");
  const code = await inviteCode(ana.sid);
  if (!code) throw new Error("no code");
  await recordInvite(bea, code, NOW - INVITED * DAY * 1000);
  await recordInvite(cal, code, NOW - INVITED * DAY * 1000);
  for (const sid of [bea.sid, cal.sid]) {
    const rec = JSON.parse(String(redis.run(["GET", byKey(sid)])));
    delete rec.terms;
    redis.run(["SET", byKey(sid), JSON.stringify(rec)]);
  }
  for (const [e, c, s] of [["ana", "Ana", "Ana"], ["bea", "Bea", "Bea"], ["cal", "Cal", "Cal"]]) {
    await setSubscription(`${e}@example.com`, { customerId: `cus_${c}0001`, subscriptionId: `sub_${s}0001`, active: true, period: paidPeriod() });
  }
  // Control: $100 invoice, $40 refund on the payment, no credit note: base $60, Ana earns $30.
  invoices.set("cus_Bea0001", [invoice("in_BeaCtrl001", 10000, LONG_PAST, LONG_PAST, "pi_ctrl")]);
  refunds.set("pi_ctrl", [{ amount: 4000, status: "succeeded" }]);
  // The same $40 refund is also in a post-payment credit note of $40 (Stripe lists it in both).
  invoices.set("cus_Cal0001", [invoice("in_CalLinked01", 10000, LONG_PAST, LONG_PAST, "pi_linked", { post_payment_credit_notes_amount: 4000 })]);
  refunds.set("pi_linked", [{ amount: 4000, status: "succeeded" }]);
  creditNotes.set("in_CalLinked01", [note("cn_linked01", 4000, 4000)]);
  await settleInvites(Date.now() + 60_000, NOW);
  const credit = (id: string) => {
    const raw = redis.run(["GET", creditKey(id)]);
    return raw === null ? "pending" : JSON.parse(String(raw)).cents;
  };
  part("A refund made through a post-payment credit note");
  is("control: refund alone, share on $60", credit("in_BeaCtrl001"), 3000);
  is("refund linked to a post-payment credit note reduces the basis once", credit("in_CalLinked01"), 3000);

  part("A credit note to the balance beside a separate refund: both taken off");
  redis.run(["DEL", creditKey("in_CalLinked01")]);
  invoices.set("cus_Cal0001", [invoice("in_CalLinked01", 10000, LONG_PAST, LONG_PAST, "pi_linked", { post_payment_credit_notes_amount: 4000 })]);
  creditNotes.set("in_CalLinked01", [note("cn_balance01", 4000, 0)]);
  await settleInvites(Date.now() + 60_000, NOW);
  is("$100 less $40 credited and $40 refunded: share on $20", credit("in_CalLinked01"), 1000);

  part("Credit notes that cannot be told apart: pending");
  redis.run(["DEL", creditKey("in_CalLinked01")]);
  creditNotes.delete("in_CalLinked01");
  await settleInvites(Date.now() + 60_000, NOW);
  is("the credit notes do not read: nothing written", credit("in_CalLinked01"), "pending");
  creditNotes.set("in_CalLinked01", [note("cn_short01", 3000, 3000)]);
  await settleInvites(Date.now() + 60_000, NOW);
  is("the notes do not add up to the invoice's credit notes amount: nothing written", credit("in_CalLinked01"), "pending");
  done();
}

main().catch((e) => { console.error(e); process.exit(1); });
