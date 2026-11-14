/**
 * A refund's sale is told only from replies in their exact shape (CX-123 rules 24 and 30; Claude 4's second review
 * of #2868). Synthetic only: the in-memory Redis double and a stand-in for the creator's Stripe account; no real
 * Stripe call is made.
 *
 * MEDIUM 1: the HGET of the sale's key answering an empty string is a reply no writer writes (settle stores a key of
 * at least MIN_KEY_LENGTH), never "this sale has no key": the refund stays unread and the next run revokes the key.
 *
 * MEDIUM 2: the invoice of a payment plan's first payment read in another shape ({}, no subscription and no parent,
 * fields of the wrong type, another object) is never "not a payment plan": the refund stays unread and the next run
 * revokes the key. The same holds for the payment's own reply and its metadata (an upsell read as "no offer"), the
 * invoice payments row and the plan's checkout read without their invoice.
 *
 * Controls: a sale that truly gave no key (the HGET answers null), a plan invoice in either API shape, an invoice that
 * says for sure it has no subscription, and a healthy upsell.
 */
import { type Store, claimHandle, ensureStatsId, addProduct, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_licence_refund_shape";
const OWNER = "licenceshape@example.com";
const HANDLE = "licenceshape";
const ACCOUNT = "acct_1TestLicShape1";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
const sessionsBySubscription: Record<string, Record<string, unknown>[]> = {};
const intents: Record<string, unknown> = {};
const invoices: Record<string, unknown> = {};
const invoicePayments: Record<string, unknown[]> = {};
let refunds: Record<string, unknown>[] = [];
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const sub = url.searchParams.get("subscription");
    if (sub) return list(sessionsBySubscription[sub] ?? []);
    return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  }
  if (path === "/refunds") return list(refunds);
  if (path === "/invoice_payments") return list(invoicePayments[url.searchParams.get("payment[payment_intent]") ?? ""] ?? []);
  const intent = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path)?.[1];
  if (intent) return Object.hasOwn(intents, intent) ? answer(intents[intent]) : answer({ error: { code: "resource_missing" } }, 404);
  const invoice = /^\/invoices\/(in_[A-Za-z0-9]+)$/.exec(path)?.[1];
  if (invoice) return Object.hasOwn(invoices, invoice) ? answer(invoices[invoice]) : answer({ error: { code: "resource_missing" } }, 404);
  return list([]);
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** The double with LPOP, which it does not implement: LINDEX 0 then LTRIM, one test process, nothing in between. */
const real = (async (commands: Command[]) => {
  if (!commands.some((command) => command[0] === "LPOP")) return memory(commands);
  const out: unknown[] = [];
  for (const command of commands) {
    if (command[0] !== "LPOP") {
      out.push((await memory([command]))[0]);
      continue;
    }
    const [head] = await memory([["LINDEX", command[1], 0]]);
    if (typeof head === "string") await memory([["LTRIM", command[1], 1, -1]]);
    out.push(typeof head === "string" ? head : null);
  }
  return out;
}) as typeof redis.pipeline;
redis.pipeline = real;

// Regra 23: the row now carries its own amount, as every refund Stripe sends does: a refund of the whole charge is whole
// on its own. Without it the job reads the charge's refunds first (Claude 2's focal money review of #2868, HIGH).
const refund = (id: string, pi: string) => ({ id, object: "refund", amount: 2900, created: NOW - 30, status: "succeeded", payment_intent: pi, charge: { object: "charge", amount: 2900, amount_refunded: 2900, refunded: true } });
const run = async (): Promise<number | "threw"> => {
  try {
    return await revokeRefunded(store, Date.now() + 10_000);
  } catch {
    return "threw";
  }
};
const seenOf = async (id: string) => (await real([["SISMEMBER", `nl:keys:${store.statsId}:refunds:seen`, id]]))[0];

let store: Store;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Licence Shape", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LicenceShape01", subscriptionId: "sub_LicenceShape01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Kiln App", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const productId = made.product.id;
  await setProductLink(OWNER, productId, "https://example.com/app");
  await setProductKeys(OWNER, productId, { source: "generated", prefix: "KILN", groups: 4, groupLength: 4, lowAt: 0 });
  store = (await storeForEmail(OWNER))!;
  const app = (await readListing(store, productId))!;
  const keyOf = async (reference: string) => {
    const given = await keyForSale(store, app, reference, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    return given.key;
  };
  const planMeta = { kind: "plan", store: HANDLE, product: productId };
  /** A payment plan's first payment: its key, its payment naming its invoice, and the checkout that started it. */
  const planSale = async (n: string, invoiceReply: (invoice: string, sub: string) => unknown) => {
    const cs = `cs_test_licshape${n}`;
    const pi = `pi_LicenceShape${n}`;
    const invoice = `in_LicenceShape${n}`;
    const sub = `sub_LicenceShape${n}`;
    const key = await keyOf(cs);
    intents[pi] = { id: pi, object: "payment_intent", metadata: {}, invoice };
    invoices[invoice] = invoiceReply(invoice, sub);
    sessionsBySubscription[sub] = [{ id: cs, object: "checkout.session", invoice, metadata: planMeta }];
    return { key, pi, invoice, sub, cs, re: `re_LicenceShape${n}` };
  };
  const oldShape = (invoice: string, sub: string) => ({ id: invoice, object: "invoice", subscription: sub });
  const newShape = (invoice: string, sub: string) => ({ id: invoice, object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: sub } } });
  /** Leaves the refund unread on a run with the bad reply, then revokes it on a run once the reply is healthy. */
  const heldThenRevoked = async (label: string, re: string, pi: string, key: string, heal: () => void) => {
    refunds = [refund(re, pi)];
    const once = await run();
    is(`${label}: nothing revoked, the refund left unread, the key not yet revoked`, [once === "threw" ? 0 : once, await seenOf(re)], [0, 0]);
    heal();
    is(`${label}: the next run (healthy reply) revokes the refunded key`, [await run(), await checkKey(store, app, key), await seenOf(re)], [1, "revoked", 1]);
  };

  part("Control: a refunded sale that truly gave no key (the HGET answers null) is read, with nothing to revoke");
  sessionsByPayment.pi_LicenceShape0001 = [{ id: "cs_test_licshape0001", object: "checkout.session", metadata: { store: HANDLE, product: productId } }];
  refunds = [refund("re_LicenceShape0001", "pi_LicenceShape0001")];
  is("the refund is marked read and nothing is revoked", [await run(), await seenOf("re_LicenceShape0001")], [0, 1]);

  part("Control: a healthy checkout sale's refund revokes its key");
  const direct = await keyOf("cs_test_licshape0002");
  sessionsByPayment.pi_LicenceShape0002 = [{ id: "cs_test_licshape0002", object: "checkout.session", metadata: { store: HANDLE, product: productId } }];
  refunds = [refund("re_LicenceShape0002", "pi_LicenceShape0002")];
  is("revoked and read", [await run(), await checkKey(store, app, direct), await seenOf("re_LicenceShape0002")], [1, "revoked", 1]);

  part("1. MEDIUM: the HGET of the sale's key answers an empty string");
  const empty = await keyOf("cs_test_licshape0003");
  sessionsByPayment.pi_LicenceShape0003 = [{ id: "cs_test_licshape0003", object: "checkout.session", metadata: { store: HANDLE, product: productId } }];
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).endsWith(":sale") && commands[0][2] === "cs_test_licshape0003") return [""];
    return real(commands);
  }) as typeof redis.pipeline;
  await heldThenRevoked("empty key", "re_LicenceShape0003", "pi_LicenceShape0003", empty, () => {
    redis.pipeline = real;
  });
  redis.pipeline = real;

  part("Control: a payment plan's refund, invoice in the older API shape (subscription), revokes its key");
  {
    const s = await planSale("0010", oldShape);
    refunds = [refund(s.re, s.pi)];
    is("revoked and read", [await run(), await checkKey(store, app, s.key), await seenOf(s.re)], [1, "revoked", 1]);
  }
  part("Control: a payment plan's refund, invoice in the newer API shape (parent), revokes its key");
  {
    const s = await planSale("0011", newShape);
    refunds = [refund(s.re, s.pi)];
    is("revoked and read", [await run(), await checkKey(store, app, s.key), await seenOf(s.re)], [1, "revoked", 1]);
  }
  part("Control: a payment plan's refund found through the invoice payments list revokes its key");
  {
    const s = await planSale("0012", newShape);
    intents[s.pi] = { id: s.pi, object: "payment_intent", metadata: {} };
    invoicePayments[s.pi] = [{ id: "inpay_LicenceShape0012", object: "invoice_payment", invoice: s.invoice }];
    refunds = [refund(s.re, s.pi)];
    is("revoked and read", [await run(), await checkKey(store, app, s.key), await seenOf(s.re)], [1, "revoked", 1]);
  }
  part("Control: an invoice that says for sure it has no subscription is not a plan: read, nothing revoked");
  for (const [n, body] of [
    ["0013", (invoice: string) => ({ id: invoice, object: "invoice", subscription: null })],
    ["0014", (invoice: string) => ({ id: invoice, object: "invoice", parent: null })],
    ["0015", (invoice: string) => ({ id: invoice, object: "invoice", parent: { type: "quote_details", quote_details: { quote: "qt_LicenceShape0015" } } })],
  ] as const) {
    const pi = `pi_LicenceShape${n}`;
    const invoice = `in_LicenceShape${n}`;
    intents[pi] = { id: pi, object: "payment_intent", metadata: {}, invoice };
    invoices[invoice] = body(invoice);
    refunds = [refund(`re_LicenceShape${n}`, pi)];
    is(`${n}: read, nothing revoked`, [await run(), await seenOf(`re_LicenceShape${n}`)], [0, 1]);
  }

  part("2. MEDIUM: the plan's invoice answers in another shape");
  const offInvoices: [string, string, (invoice: string, sub: string) => unknown][] = [
    ["0020", "an empty object", () => ({})],
    ["0021", "an invoice with neither subscription nor parent", (invoice) => ({ id: invoice, object: "invoice" })],
    ["0022", "a subscription of the wrong type", (invoice) => ({ id: invoice, object: "invoice", subscription: 42 })],
    ["0023", "a subscription object without an id", (invoice) => ({ id: invoice, object: "invoice", subscription: { object: "subscription" } })],
    ["0024", "a parent that is not an object", (invoice) => ({ id: invoice, object: "invoice", parent: "subscription_details" })],
    ["0025", "a parent without a type", (invoice, sub) => ({ id: invoice, object: "invoice", parent: { subscription_details: { subscription: sub } } })],
    ["0026", "a subscription parent without its details", (invoice) => ({ id: invoice, object: "invoice", parent: { type: "subscription_details" } })],
    ["0027", "a subscription parent whose subscription is not an id", (invoice) => ({ id: invoice, object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: 7 } } })],
    ["0028", "a parent of a type no API version gives", (invoice, sub) => ({ id: invoice, object: "invoice", parent: { type: "mystery_details", subscription_details: { subscription: sub } } })],
    ["0029", "another object", (invoice, sub) => ({ id: invoice, object: "charge", subscription: sub })],
    ["0030", "another invoice's id", (_invoice, sub) => ({ id: "in_SomeOtherInvoice1", object: "invoice", subscription: sub })],
    ["0031", "a list instead of an invoice", (invoice, sub) => [{ id: invoice, object: "invoice", subscription: sub }]],
  ];
  for (const [n, label, reply] of offInvoices) {
    const s = await planSale(n, reply);
    await heldThenRevoked(`${n} ${label}`, s.re, s.pi, s.key, () => {
      invoices[s.invoice] = oldShape(s.invoice, s.sub);
    });
  }

  part("2b. The invoice payments row answers without a readable invoice");
  {
    const s = await planSale("0040", newShape);
    intents[s.pi] = { id: s.pi, object: "payment_intent", metadata: {} };
    invoicePayments[s.pi] = [{ id: "inpay_LicenceShape0040", object: "invoice_payment", invoice: 9 }];
    await heldThenRevoked("0040 invoice payment row with a numeric invoice", s.re, s.pi, s.key, () => {
      invoicePayments[s.pi] = [{ id: "inpay_LicenceShape0040", object: "invoice_payment", invoice: s.invoice }];
    });
  }

  part("2c. The plan's checkout answers without its invoice");
  {
    const s = await planSale("0041", oldShape);
    sessionsBySubscription[s.sub] = [{ id: s.cs, object: "checkout.session", metadata: planMeta }];
    await heldThenRevoked("0041 checkout without an invoice field", s.re, s.pi, s.key, () => {
      sessionsBySubscription[s.sub] = [{ id: s.cs, object: "checkout.session", invoice: s.invoice, metadata: planMeta }];
    });
  }

  part("Control: a healthy upsell's refund revokes its key");
  const upsellMeta = { kind: "upsell", store: HANDLE, product: productId };
  {
    const key = await keyOf("pi_LicenceShape0050");
    intents.pi_LicenceShape0050 = { id: "pi_LicenceShape0050", object: "payment_intent", metadata: upsellMeta };
    refunds = [refund("re_LicenceShape0050", "pi_LicenceShape0050")];
    is("revoked and read", [await run(), await checkKey(store, app, key), await seenOf("re_LicenceShape0050")], [1, "revoked", 1]);
  }

  part("3. The payment (an upsell) answers in another shape");
  const offIntents: [string, string, (pi: string) => unknown][] = [
    ["0051", "an empty object", () => ({})],
    ["0052", "a payment without metadata", (pi) => ({ id: pi, object: "payment_intent" })],
    ["0053", "metadata that is not an object", (pi) => ({ id: pi, object: "payment_intent", metadata: "kind=upsell" })],
    ["0054", "metadata with a value that is not text", (pi) => ({ id: pi, object: "payment_intent", metadata: { ...upsellMeta, kind: 5 } })],
    ["0055", "another object", (pi) => ({ id: pi, object: "charge", metadata: upsellMeta })],
    ["0056", "another payment's id", () => ({ id: "pi_SomeOtherIntent1", object: "payment_intent", metadata: upsellMeta })],
  ];
  for (const [n, label, reply] of offIntents) {
    const pi = `pi_LicenceShape${n}`;
    const key = await keyOf(pi);
    intents[pi] = reply(pi);
    await heldThenRevoked(`${n} ${label}`, `re_LicenceShape${n}`, pi, key, () => {
      intents[pi] = { id: pi, object: "payment_intent", metadata: upsellMeta };
    });
  }

  part("3b. A checkout's metadata with a value that is not text is not \"another store's sale\"");
  {
    const key = await keyOf("cs_test_licshape0060");
    sessionsByPayment.pi_LicenceShape0060 = [{ id: "cs_test_licshape0060", object: "checkout.session", metadata: { store: 1, product: productId } }];
    await heldThenRevoked("0060 checkout store that is a number", "re_LicenceShape0060", "pi_LicenceShape0060", key, () => {
      sessionsByPayment.pi_LicenceShape0060 = [{ id: "cs_test_licshape0060", object: "checkout.session", metadata: { store: HANDLE, product: productId } }];
    });
  }

  part("4. A refund row whose payment is not an id is not \"a charge made without a payment\" (rule 30 sibling)");
  {
    const key = await keyOf("cs_test_licshape0070");
    sessionsByPayment.pi_LicenceShape0070 = [{ id: "cs_test_licshape0070", object: "checkout.session", metadata: { store: HANDLE, product: productId } }];
    refunds = [{ ...refund("re_LicenceShape0070", "pi_LicenceShape0070"), payment_intent: 7 }];
    const once = await run();
    is("0070: nothing revoked, the refund left unread", [once === "threw" ? 0 : once, await seenOf("re_LicenceShape0070")], [0, 0]);
    refunds = [refund("re_LicenceShape0070", "pi_LicenceShape0070")];
    is("0070: the next run (healthy row) revokes the refunded key", [await run(), await checkKey(store, app, key), await seenOf("re_LicenceShape0070")], [1, "revoked", 1]);
  }
  part("Control: a refund of a charge made without a payment (payment_intent null) is read");
  refunds = [{ ...refund("re_LicenceShape0071", "pi_LicenceShape0071"), payment_intent: null }];
  is("read, nothing revoked", [await run(), await seenOf("re_LicenceShape0071")], [0, 1]);

  is("no call left the synthetic Stripe stand-in", calls.every((path) => path.startsWith("/v1/")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
