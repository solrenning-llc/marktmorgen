/**
 * A closing never records a made-up paid share for a membership line (row 89 of #5010; Codex
 * G-20261119-0634-fix-main-closing-membership-line-money-exact). membershipLineOf (lib/closing-buyers-rules.ts) shares
 * what the invoice took (amount_paid) between the membership's line and every line's net. A line amount or a discount
 * that is not a whole number of cents, a negative discount, or an amount_paid that is not one, is money that could
 * not be read: it was turned into zero (or taken as Number(...) unchecked) and the share came out wrong. Now it throws,
 * and the existing retry path of the closing (lib/closing-holds.ts, holdRows) tries the member again, with nothing
 * written. Synthetic invoices only.
 */
import { store as redis } from "./redis-stub";
import { membershipLineOf } from "@/lib/closing-buyers-rules";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { paidKey, retryHolds, workKey } from "@/lib/closing-holds";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_membership_line_exact_only";

const PERIOD = { start: 1_700_000_000, end: 1_702_592_000 };
const membership = (extra: Record<string, unknown> = {}) => ({ type: "subscription", amount: 2_000, period: PERIOD, discount_amounts: [{ amount: 1_000 }], ...extra });
const other = (extra: Record<string, unknown> = {}) => ({ type: "invoiceitem", amount: 1_000, ...extra });

/** The share, or "unknown" when the invoice's money could not be read (the closing tries the member again). */
function share(invoice: Parameters<typeof membershipLineOf>[0]): number | null | "unknown" {
  try {
    return membershipLineOf(invoice)?.amt ?? null;
  } catch {
    return "unknown";
  }
}

const invoice = (lines: Record<string, unknown>[], amount_paid: unknown = 2_000) => ({ lines: { data: lines as never[] }, amount_paid });

async function main() {
part("An invoice whose money reads: the membership's share, as before");
// 2,000 less a 1,000 coupon is 1,000 of 2,000 in nets, and 2,000 was paid: the membership's share is 1,000.
is("a 2,000 membership with a 1,000 coupon and a 1,000 line, 2,000 paid: 1,000", share(invoice([membership(), other()])), 1_000);
is("the membership alone, nothing else on the invoice: its net, 1,000", share(invoice([membership()], 1_000)), 1_000);

part("Another line's amount that is not whole cents is never read as zero");
is("its amount as text \"1000\"", share(invoice([membership(), other({ amount: "1000" })])), "unknown");
is("its amount with a fraction, 1000.5", share(invoice([membership(), other({ amount: 1000.5 })])), "unknown");
is("its amount past a safe integer", share(invoice([membership(), other({ amount: 2 ** 60 })])), "unknown");

part("A discount that is not whole cents, or is negative, is never read as zero");
is("the membership's discount as text \"1000\"", share(invoice([membership({ discount_amounts: [{ amount: "1000" }] }), other()])), "unknown");
is("a discount with a fraction", share(invoice([membership({ discount_amounts: [{ amount: 999.5 }] }), other()])), "unknown");
is("a negative discount", share(invoice([membership({ discount_amounts: [{ amount: -1 }] }), other()])), "unknown");
is("a discount past a safe integer", share(invoice([membership(), other({ discount_amounts: [{ amount: 2 ** 60 }] })])), "unknown");
is("discounts that are not a list", share(invoice([membership({ discount_amounts: "none" }), other()])), "unknown");

part("Another line's amount that is missing or null is never read as zero");
is("its amount absent", share(invoice([membership(), { type: "invoiceitem" }])), "unknown");
is("its amount null", share(invoice([membership(), other({ amount: null })])), "unknown");

part("The membership's own line is picked by what it is, and its figures must read (coordinator 7405)");
is("its amount as text \"2000\"", share(invoice([membership({ amount: "2000" }), other()])), "unknown");
is("its amount NaN", share(invoice([membership({ amount: Number.NaN }), other()])), "unknown");
is("its period's end not a number", share(invoice([membership({ period: { start: PERIOD.start, end: "1702592000" } }), other()])), "unknown");
is("its period's start missing", share(invoice([membership({ period: { end: PERIOD.end } }), other()])), "unknown");
is("its period ending before it starts", share(invoice([membership({ period: { start: PERIOD.end, end: PERIOD.start } }), other()])), "unknown");
is("its amount read as 0: no paid membership, null", share(invoice([membership({ amount: 0, discount_amounts: [] }), other()], 1_000)), null);
is("a proration line is still never the membership's own", share(invoice([membership({ proration: true }), other()])), null);

part("What the invoice took must be whole cents too");
is("amount_paid as text \"2000\"", share(invoice([membership(), other()], "2000")), "unknown");
is("amount_paid with a fraction", share(invoice([membership(), other()], 2000.5)), "unknown");
is("amount_paid negative", share(invoice([membership(), other()], -5)), "unknown");

// The hold at a closing reads the paid period before any write (lib/closing-holds.ts, holdOne): a paid invoice whose
// money does not read leaves the member's open invoice unvoided, its draft untouched and nothing written down, and the
// member is tried again. Against a stand-in for Stripe; nothing real is reached.
const ACCOUNT = "acct_1ClosingLineExa";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const MEMBER = "sub_ClosingLineExa1";
const CUSTOMER = "cus_ClosingLineExa";
const HANDLE = "closing-line-exact";
const writes: string[] = [];
let lists: Record<string, Record<string, unknown>[]> = {};
const sub = { id: MEMBER, status: "active", metadata: { store: HANDLE }, customer: { id: CUSTOMER, email: "member@example.com" } };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    writes.push(`${method} ${path}`);
    return json({ id: path.split("/").pop() });
  }
  if (path === `/subscriptions/${MEMBER}`) return json(sub);
  if (path === "/invoices") return json({ object: "list", data: lists[url.searchParams.get("status") ?? ""] ?? [], has_more: false });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const PE = Math.floor(ENDED_AT / 1000) + 20 * 86_400;
const paidInvoice = (lineExtra: Record<string, unknown>, ownExtra: Record<string, unknown> = {}, n = 1, pe = PE) => ({
  id: `in_LineExactPaid${n}`, status: "paid", amount_paid: 2_000, currency: "usd", payment_intent: `pi_LineExactPaid${n}`, subscription: MEMBER, customer: CUSTOMER,
  lines: { data: [{ type: "subscription", proration: false, amount: 2_000, discount_amounts: [], period: { start: pe - 30 * 86_400, end: pe }, ...ownExtra }, { type: "invoiceitem", amount: 500, ...lineExtra }] },
});
/** An older paid invoice whose period was already used up before the closing. */
const OLDER_PE = PE - 60 * 86_400;
const ownOpen = { id: "in_LineExactOpen1", status: "open", subscription: MEMBER, customer: CUSTOMER };
const ownDraft = { id: "in_LineExactDrft1", status: "draft", auto_advance: true, subscription: MEMBER, customer: CUSTOMER };

async function hold(lineExtra: Record<string, unknown>, paidList: Record<string, unknown>[] = [paidInvoice(lineExtra)]) {
  redis.clear();
  writes.length = 0;
  const email = "closing-line-exact@example.com";
  await claimHandle(email, HANDLE, "Closing line exact", "");
  await setStripeAccount(email, ACCOUNT, true);
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redis.pipeline([["HSET", workKey(folder), "calls", 100, `f:${MEMBER}`, "1", `m:${MEMBER}`, "member@example.com"]]);
  lists = { open: [ownOpen], draft: [ownDraft], paid: paidList };
  const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
  const paid = await redis.run(["HGETALL", paidKey(folder)]);
  const keys = await redis.run(["HKEYS", workKey(folder)]);
  return { counts, writes: [...writes], paid: Array.isArray(paid) ? paid.length : -1, retried: Array.isArray(keys) && keys.map(String).includes(`f:${MEMBER}`) };
}

part("At a closing, a paid invoice whose money reads: the member is held as before");
{
  const got = await hold({});
  is("its open invoice is voided, its draft kept, it is held", [got.writes.includes(`POST /invoices/${ownOpen.id}/void`), got.writes.includes(`POST /invoices/${ownDraft.id}`), got.writes.includes(`POST /subscriptions/${MEMBER}`)], [true, true, true]);
  is("its last payment is written down and it leaves the line", [got.paid, got.retried, got.counts.failed], [2, false, 0]);
}

part("At a closing, a paid invoice whose money does not read: nothing is written, the member is tried again");
for (const [what, extra] of [["another line's amount as text", { amount: "500" }], ["a fractional discount", { discount_amounts: [{ amount: 0.5 }] }]] as const) {
  const got = await hold(extra);
  is(`(${what}) nothing is written to Stripe`, got.writes, []);
  is(`(${what}) no payment is written down, the member is tried again`, [got.paid, got.retried, got.counts.failed], [0, true, 1]);
}
part("At a closing, the newest paid invoice's own line does not read: nothing is written, an older invoice is never taken");
for (const [what, own] of [["its amount as text", { amount: "2000" }], ["its amount NaN", { amount: Number.NaN }], ["its end not a number", { period: { start: PE - 30 * 86_400, end: String(PE) } }], ["its start missing", { period: { end: PE } }]] as const) {
  const alone = await hold({}, [paidInvoice({}, own)]);
  is(`(${what}, no other paid invoice) nothing is written to Stripe, the member is tried again`, [alone.writes, alone.paid, alone.retried, alone.counts.failed], [[], 0, true, 1]);
  const older = await hold({}, [paidInvoice({}, own), paidInvoice({}, {}, 2, OLDER_PE)]);
  is(`(${what}, an older paid invoice behind it) the older, used-up period is never written down`, [older.writes, older.paid, older.retried, older.counts.failed], [[], 0, true, 1]);
}

part("At a closing, an older paid invoice that does not read never blocks a member whose newest one does (coordinator 7405, LEVE 1)");
{
  const got = await hold({}, [paidInvoice({}), paidInvoice({ amount: "500" }, {}, 2, OLDER_PE)]);
  is("held from the newest invoice, its last payment written down", [got.writes.includes(`POST /subscriptions/${MEMBER}`), got.paid, got.retried, got.counts.failed], [true, 2, false, 0]);
}
done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
