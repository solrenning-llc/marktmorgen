/**
 * CX-123 rule 24 on the buyer's emails that follow a payment (audit R48, the same pattern as the pre-order, gift and
 * payment-request receipts; Claude 3's review of #3388). The amount and the currency on the email are what Stripe
 * charged, read exactly: a whole number of cents, never below zero, in a three-letter currency. When either is
 * unknown, the email never states a guessed value (the catalog's price times the people, $0, or the store's own
 * currency): the "Paid" line is left out, and the rest of the email goes as before, because the link it carries is
 * what the buyer paid for:
 *
 *   - the receipt for a purchase for several (lib/group-buy.ts, settleGroup and resendGroupReceipt);
 *   - the confirmation of an offer taken in one click after paying (lib/upsell.ts afterPaid, then confirmOffer in
 *     lib/purchase-email.ts), on the charge's own answer and when it is settled later from what Stripe says.
 *
 * Every healthy case is checked unchanged. Synthetic only: Stripe and Resend stand-ins, Redis stub.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { resendGroupReceipt, settleGroup, startGroup } from "@/lib/group-buy";
import { newUpsellKey, readUpsell, settleUpsells, takeUpsell } from "@/lib/upsell";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_r48_email_amounts_only";
process.env.RESEND_API_KEY = "re_test_groups_only";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
const NOW = Math.floor(Date.now() / 1000);
const OWNER = "r48-amounts-owner@example.com";
const BASE = "https://marktmorgen.com/@harbor";
const FROM = '"Harbor Kitchen" <hello@marktmorgen.com>';

/** What the next one-click charge answers on top of what was asked: `undefined` takes a field out. */
let piOver: Record<string, unknown> = {};
let piStatus: "succeeded" | "requires_action" = "succeeded";
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return answer({ id: `email_${emails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const pi: Record<string, unknown> = {
      id: `pi_R48Amount${String(made.length + 1).padStart(6, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: piStatus,
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      ...(piStatus === "requires_action" ? { next_action: { redirect_to_url: { url: "https://hooks.stripe.com/3ds/confirm" } } } : {}),
      ...piOver,
    };
    for (const key of Object.keys(piOver)) if (piOver[key] === undefined) delete pi[key];
    made.push(pi);
    return answer(pi);
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const lineOf = (text: string, start: string) => text.split("\n").find((line) => line.startsWith(start)) ?? null;
const without = (record: Record<string, unknown>, over: Record<string, unknown>) => {
  const copy = { ...record, ...over };
  for (const key of Object.keys(over)) if (over[key] === undefined) delete copy[key];
  return copy;
};

async function groups(): Promise<void> {
  part("Receipt for a purchase for several: the amount Stripe charged, or no amount line");
  const store = (await storeForEmail(OWNER))!;
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const product = (await readListing((await storeForEmail(OWNER))!, made.product.id)) as Listing;

  const settle = async (n: number, over: Record<string, unknown>) => {
    const started = await startGroup(store, product, "2");
    if (!started.ok) throw new Error("no purchase for several");
    emails.length = 0;
    const session = without({
      id: `cs_test_r48group${n}${"g".repeat(16)}`,
      created: 1_900_000_000,
      amount_total: 9000,
      currency: "usd",
      payment_intent: `pi_R48Group000${n}`,
      metadata: { store: "harbor", product: product.id, group: started.group.id, people: "2" },
      customer_details: { email: `group${n}@example.com` },
    }, over);
    const outcome = await settleGroup({ store, session, product, base: BASE, from: FROM });
    const receipt = emails.find((e) => e.to[0] === `group${n}@example.com`)?.text ?? "";
    emails.length = 0;
    const again = await resendGroupReceipt({ store, session, product, base: BASE, from: FROM });
    const resent = emails.find((e) => e.to[0] === `group${n}@example.com`)?.text ?? "";
    return { outcome, receipt, again, resent, link: `${BASE}/group/${started.group.id}` };
  };

  const healthy = await settle(1, {});
  is("healthy: settled, the receipt says what Stripe charged, with the link", [healthy.outcome, lineOf(healthy.receipt, "Paid:"), healthy.receipt.includes(healthy.link)], ["settled", "Paid: $90", true]);
  is("healthy: sent again from the studio, the same amount", [healthy.again, lineOf(healthy.resent, "Paid:")], [true, "Paid: $90"]);

  const noAmount = await settle(2, { amount_total: undefined });
  is("no amount: still settled, and the receipt with its link goes", [noAmount.outcome, noAmount.receipt.includes(noAmount.link)], ["settled", true]);
  is("no amount: no amount line, never the catalog's $49 × 2", [lineOf(noAmount.receipt, "Paid:"), noAmount.receipt.includes("$98")], [null, false]);
  is("no amount, sent again: no amount line either", [noAmount.again, lineOf(noAmount.resent, "Paid:"), noAmount.resent.includes("$98")], [true, null, false]);

  const textAmount = await settle(3, { amount_total: "9000" });
  is("an amount in another shape: no amount line", lineOf(textAmount.receipt, "Paid:"), null);

  const fraction = await settle(4, { amount_total: 90.5 });
  is("an amount that is not a whole number of cents: no amount line", lineOf(fraction.receipt, "Paid:"), null);

  const below = await settle(5, { amount_total: -9000 });
  is("an amount below zero: no amount line", lineOf(below.receipt, "Paid:"), null);

  const noCurrency = await settle(6, { currency: undefined });
  is("no currency: no amount line, never in the store's currency", lineOf(noCurrency.receipt, "Paid:"), null);

  const oddCurrency = await settle(7, { currency: "US Dollar" });
  is("a currency that is not a three-letter code: no amount line", lineOf(oddCurrency.receipt, "Paid:"), null);

  const free = await settle(8, { amount_total: 0 });
  is("a real zero (a 100% code) is what was charged: stated as is", lineOf(free.receipt, "Paid:"), "Paid: $0");
}

async function offers(): Promise<void> {
  part("Confirmation of an offer taken in one click: the amount Stripe charged, or no amount line");
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Bread Basics", "39");
  const kit = await add("Starter Kit Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: kit, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const browser = newUpsellKey();
  const buyerOf = (n: number) => `offer${n}@example.com`;
  const order = (n: number) => {
    const id = `cs_test_r48offer${String(n).padStart(7, "0")}`;
    sessions[id] = {
      id,
      status: "complete",
      payment_status: "paid",
      created: NOW - 60,
      customer: "cus_TestR48Buyer",
      currency: "usd",
      amount_total: 3900,
      metadata: { store: "harbor", product: front, upsell_key: browser.fingerprint },
      customer_details: { email: buyerOf(n) },
      payment_intent: { id: `pi_test_r48front${n}`, payment_method: { id: "pm_test_r48card01", type: "card", customer: "cus_TestR48Buyer" } },
    };
    return id;
  };
  const take = async (n: number, over: Record<string, unknown>) => {
    piOver = over;
    emails.length = 0;
    const session = order(n);
    const outcome = await takeUpsell({ store, session, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });
    piOver = {};
    const letter = emails.find((e) => e.to[0] === buyerOf(n))?.text ?? "";
    return { outcome: outcome.kind, letter };
  };

  const healthy = await take(1, {});
  is("healthy: done, the confirmation says what Stripe charged", [healthy.outcome, lineOf(healthy.letter, "Paid:")], ["done", "Paid: $19, charged once to the card you had just paid with"]);

  const noAmount = await take(2, { amount: undefined });
  is("no amount: still done, and the confirmation goes", [noAmount.outcome, noAmount.letter.includes("Starter Kit Guide")], ["done", true]);
  is("no amount: no amount line, never $0", [lineOf(noAmount.letter, "Paid:"), noAmount.letter.includes("$0")], [null, false]);

  const textAmount = await take(3, { amount: "1900" });
  is("an amount in another shape: no amount line, never $0", [lineOf(textAmount.letter, "Paid:"), textAmount.letter.includes("$0")], [null, false]);

  const below = await take(4, { amount: -1900 });
  is("an amount below zero: no amount line", lineOf(below.letter, "Paid:"), null);

  const noCurrency = await take(5, { currency: undefined });
  is("no currency: no amount line, never in the store's currency", lineOf(noCurrency.letter, "Paid:"), null);

  const oddCurrency = await take(6, { currency: 840 });
  is("a currency in another shape: no amount line", lineOf(oddCurrency.letter, "Paid:"), null);

  part("The same, when the offer is settled later from what Stripe says");
  piStatus = "requires_action";
  const pending = order(7);
  piOver = { amount: undefined };
  const asked = await takeUpsell({ store, session: pending, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });
  piOver = {};
  piStatus = "succeeded";
  is("sent to confirm with the bank first", asked.kind, "confirm");
  made[made.length - 1].status = "succeeded";
  emails.length = 0;
  await settleUpsells(store, pending);
  const settled = emails.find((e) => e.to[0] === buyerOf(7))?.text ?? "";
  is("settled as paid, and the confirmation goes", [(await readUpsell(pending, "kit001"))?.state ?? (await readUpsell(pending))?.state, settled.includes("Starter Kit Guide")], ["paid", true]);
  is("no amount on Stripe's answer: no amount line, never $0", [lineOf(settled, "Paid:"), settled.includes("$0")], [null, false]);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestR48Amounts", true);
  await setSubscription(OWNER, { customerId: "cus_R48Amounts01", subscriptionId: "sub_R48Amounts01", active: true, period: paidPeriod() });
  await groups();
  await offers();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
