/**
 * Rule 30 in the closing refunds (lib/closing-refunds.ts, Claude 6's money review of #3097): a Stripe reply decides
 * only when it is the object asked for. The invoice read for its payment, the payment read for its charge and the
 * invoice's payments listed when the invoice names none: another object's reply, or one with no id, names another
 * payment, so a refund would be POSTed on someone else's payment and this member settled "done", or another payment's
 * disputed charge would settle this member "disputed" with nothing given back. Each must be counted failed and tried
 * again: nothing POSTed, nothing settled, the member still listed, and only the calls made taken from the budget.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { giveBackUnused, unusedRows } from "@/lib/closing-refunds";
import { paidKey, workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
const ACCOUNT = "acct_closeown1";
const SUB = "sub_closeown1";
const INVOICE = "in_closeown1";
const INTENT = "pi_closeown1";
const OTHER_INTENT = "pi_closeother1";
const CALLS = 20;

type World = {
  invoice: unknown;
  listed: unknown;
  intent: (id: string) => unknown;
};
let world: World;
let posts: string[] = [];

const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_closeown1", amount: 1000, currency: "usd", amount_refunded: 0, disputed: false, balance_transaction: null, ...over });
const ownIntent = (id: string) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: id }) });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/balance") return Response.json({ object: "balance", available: [{ amount: 100_000, currency: "usd" }] });
  if (path === `/invoices/${INVOICE}`) return Response.json(world.invoice);
  if (path === "/invoice_payments") return Response.json(world.listed);
  if (path.startsWith("/payment_intents/")) return Response.json(world.intent(decodeURIComponent(path.slice("/payment_intents/".length))));
  if (path === "/refunds" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const pi = String(body.get("payment_intent"));
    posts.push(pi);
    return Response.json({ id: "re_closeown1", object: "refund", amount: Number(body.get("amount")), currency: "usd", payment_intent: pi, status: "succeeded" });
  }
  if (path === "/refunds") return Response.json({ object: "list", data: [], has_more: false });
  // A disputed charge's own disputes (lib/closing-dispute.ts): one still open, so the charge is held, never given back.
  if (path === "/disputes") return Response.json({ object: "list", has_more: false, data: [{ id: "du_closeown1", object: "dispute", charge: url.searchParams.get("charge"), status: "needs_response" }] });
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

/** One member paid for 30 days by INVOICE, half of them past DAY; `knownIntent` is whether the hold kept its payment. */
async function run(label: string, knownIntent: boolean, next: World) {
  redis.clear();
  posts = [];
  world = next;
  const email = `ownreply-${label}@example.com`;
  await claimHandle(email, `ownreply${label}`, "Own reply fixture", "");
  const shop = (await storeForEmail(email))!;
  const seller: Store = { ...shop, stripeAccountId: ACCOUNT };
  const folder = await storeFolder(email);
  await redis.pipeline([
    ["HSET", paidKey(folder), SUB, JSON.stringify({ inv: INVOICE, ...(knownIntent ? { pi: INTENT } : {}), amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" })],
    ["HSET", workKey(folder), "calls", CALLS],
  ]);
  const out = await giveBackUnused(seller, DAY);
  const [raw, calls] = await redis.pipeline([["HGET", paidKey(folder), SUB], ["HGET", workKey(folder), "calls"]]);
  const saved = JSON.parse(String(raw)) as { r?: string };
  const result = typeof out === "object" ? out : null;
  console.log(JSON.stringify({ label, posts, out, saved: saved.r ?? null, calls }));
  return { result, settled: saved.r ?? null, listed: (await unusedRows(seller, DAY)).length, used: CALLS - Number(calls) };
}

/** What a reply that is not the object asked for must leave: nothing POSTed, nothing settled, counted failed, still listed. */
async function triedAgain(label: string, knownIntent: boolean, next: World, used: number) {
  const got = await run(label, knownIntent, next);
  is("no refund is POSTed, on any payment", posts, []);
  is("the member is not settled (not done, none or disputed)", got.settled, null);
  is("counted failed, so it is tried again", got.result ? [got.result.failed, got.result.done.length, got.result.none, got.result.disputed] : got.result, [1, 0, 0, 0]);
  is("still listed for the next run", got.listed, 1);
  is("only the calls made are taken from the budget", got.used, used);
}

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_closing_own_reply_synthetic";
  const ownInvoice = { id: INVOICE, object: "invoice", payment_intent: INTENT };

  part("Control: every reply is the object asked for, so this member's own payment is refunded");
  const control = await run("control", false, { invoice: ownInvoice, listed: null, intent: ownIntent });
  is("one refund, on this member's payment", posts, [INTENT]);
  is("settled done", [control.settled, control.result?.done.length], ["done", 1]);

  part("Control: the invoice names no payment, and its own paid payment is listed");
  const listedControl = await run("listedcontrol", false, {
    invoice: { id: INVOICE, object: "invoice", payment_intent: null },
    listed: { object: "list", has_more: false, data: [{ id: "inpay_closeown1", object: "invoice_payment", invoice: INVOICE, status: "paid", payment: { type: "payment_intent", payment_intent: INTENT } }] },
    intent: ownIntent,
  });
  is("one refund, on this member's payment", posts, [INTENT]);
  is("settled done", [listedControl.settled, listedControl.result?.done.length], ["done", 1]);

  part("The invoice read answers with another invoice, which names another payment");
  await triedAgain("otherinvoice", false, { invoice: { id: "in_closeother1", object: "invoice", payment_intent: OTHER_INTENT }, listed: null, intent: ownIntent }, 1);

  part("The invoice read answers with no id, naming another payment");
  await triedAgain("noid", false, { invoice: { object: "invoice", payment_intent: OTHER_INTENT }, listed: null, intent: ownIntent }, 1);

  part("The invoice read answers with JSON null");
  await triedAgain("nullinvoice", false, { invoice: null, listed: null, intent: ownIntent }, 1);

  part("The invoice names no payment, and the list of its payments holds another invoice's paid payment");
  await triedAgain(
    "otherrow",
    false,
    {
      invoice: { id: INVOICE, object: "invoice", payment_intent: null },
      listed: { object: "list", has_more: false, data: [{ id: "inpay_closeother1", object: "invoice_payment", invoice: "in_closeother1", status: "paid", payment: { type: "payment_intent", payment_intent: OTHER_INTENT } }] },
      intent: ownIntent,
    },
    2,
  );

  part("The payment read answers with another payment, whose charge is disputed");
  await triedAgain("otherintent", true, { invoice: ownInvoice, listed: null, intent: () => ({ id: OTHER_INTENT, object: "payment_intent", latest_charge: charge({ payment_intent: OTHER_INTENT, disputed: true }) }) }, 1);

  part("The payment read answers with no id, and a disputed charge");
  await triedAgain("intentnoid", true, { invoice: ownInvoice, listed: null, intent: () => ({ object: "payment_intent", latest_charge: charge({ disputed: true }) }) }, 1);

  part("The payment read is this payment, but its expanded charge belongs to another payment and is disputed");
  await triedAgain("othercharge", true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: OTHER_INTENT, disputed: true }) }) }, 1);

  // Claude 6 on #3097 (the same MEDIUM as Codex G's on #3120): a paid payment whose intent does not read, or a list that
  // is not whole, is not "this invoice was paid by nothing"; settling "none" there would close the member for good.
  const noIntentInvoice = { id: INVOICE, object: "invoice", payment_intent: null };
  part("The invoice names no payment, and its own paid payment is listed with no readable intent");
  await triedAgain(
    "paidnointent",
    false,
    {
      invoice: noIntentInvoice,
      listed: { object: "list", has_more: false, data: [{ id: "inpay_closeown2", object: "invoice_payment", invoice: INVOICE, status: "paid", payment: { type: "payment_intent", payment_intent: 7 } }] },
      intent: ownIntent,
    },
    2,
  );

  part("The invoice names no payment, and the list of its payments is not whole (has_more)");
  await triedAgain("notwhole", false, { invoice: noIntentInvoice, listed: { object: "list", has_more: true, data: [{ id: "inpay_closeown3", object: "invoice_payment", invoice: INVOICE, status: "canceled" }] }, intent: ownIntent }, 2);

  part("The invoice names no payment, and the list says whether it is whole in no readable way");
  await triedAgain("nohasmore", false, { invoice: noIntentInvoice, listed: { object: "list", data: [] }, intent: ownIntent }, 2);

  part("Control: a whole list with no paid payment still settles the member none");
  const nonePaid = await run("nonepaid", false, { invoice: noIntentInvoice, listed: { object: "list", has_more: false, data: [{ id: "inpay_closeown4", object: "invoice_payment", invoice: INVOICE, status: "canceled" }] }, intent: ownIntent });
  is("nothing POSTed", posts, []);
  is("settled none", [nonePaid.settled, nonePaid.result?.none], ["none", 1]);

  // Codex G's second money review of #3097 (inherited): what was given back is read exactly, or nothing is given. An
  // amount_refunded that is not a whole number read as 0 would give back again what was already given back by hand.
  for (const [label, value, key] of [["null", null, "rnull"], ["a string", "500", "rtext"], ["an object", { amount: 500 }, "robj"], ["negative", -1, "rneg"], ["a fraction", 1.5, "rfrac"]] as const) {
    part(`This payment's own charge says what was given back as ${label}`);
    await triedAgain(key, true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: id, amount_refunded: value }) }) }, 1);
  }
  // Codex G's focal on #3097 (5815090132, proof g3097-refunded-overcharge): more given back than the charge took is
  // not a reading of this charge; settling "none" on it would leave the member's unused time never given back.
  part("This payment's own charge says more was given back than it took");
  await triedAgain("rover", true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: id, amount_refunded: 1001 }) }) }, 1);
  part("This payment's own charge says what it took in no readable way");
  await triedAgain("ramt", true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: id, amount: "1000" }) }) }, 1);

  part("This payment's charge is not expanded (only its id)");
  await triedAgain("chargeid", true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: "ch_closeown1" }) }, 1);

  // Regra 23 (claude5/closing-dispute-won): `disputed: true` alone no longer settles; the charge's own dispute list is
  // read, and the stand-in above answers it with an open dispute. The assertions below are unchanged.
  part("Control: this payment's own disputed charge, its dispute still open, settles the member disputed, with nothing POSTed");
  const disputed = await run("owndisputed", true, { invoice: ownInvoice, listed: null, intent: (id) => ({ id, object: "payment_intent", latest_charge: charge({ payment_intent: id, disputed: true }) }) });
  is("nothing POSTed", posts, []);
  is("settled disputed", [disputed.settled, disputed.result?.disputed], ["disputed", 1]);
  done();
}

void main();
