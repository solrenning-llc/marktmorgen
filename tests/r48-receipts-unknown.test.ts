/**
 * CX-123 rule 24 on receipts (audit R48, findings 3 and 5). A receipt says the amount and the currency Stripe
 * charged, read exactly: a whole number of cents and a three-letter currency. When either is unknown, the email
 * never states a guessed value (the catalog's current price, the total before tax, the store's currency or $0):
 *
 *   - the pre-order receipt is held (confirmPreorder answers "failed", so its caller lets the mark go and a later
 *     pass, reading the checkout again, sends it);
 *   - a payment request is not written down as paid at a guessed amount (markPaid throws UnknownReplyError, the
 *     request stays open, and the confirmation is tried again);
 *   - the gift receipt leaves the amount line out;
 *   - the creator's "New sale" line leaves the amount out.
 *
 * And a payment request's receipt with sales tax added on top shows the tax and the total, so its lines add up to
 * what was paid. Every healthy case is checked unchanged. Synthetic only: Stripe and Resend stand-ins, Redis stub.
 */
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setChatSales, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, startGift } from "@/lib/gifts";
import { confirmPreorder } from "@/lib/preorders";
import { createRequest, markPaid, requestOf, sendReceipt } from "@/lib/payment-request-store";
import { readDraft } from "@/lib/payment-request-rules";
import { noteOfferSale, noteSales, type SaleRecord } from "@/lib/sale-events";
import { setChatAddress } from "@/lib/chat-summary";
import { REQUEST_WORDS } from "@/lib/buyer-words/requests";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { speechFor } from "@/lib/buyer-words";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Sent = { to: string[]; subject: string; text: string };
const emails: Sent[] = [];
const posted: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  if (url.hostname === "hooks.slack.com") {
    posted.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok");
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "r48-receipts-owner@example.com";
const SLACK = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestR48Receipts", true);
  await setSubscription(OWNER, { customerId: "cus_R48Receipt01", subscriptionId: "sub_R48Receipt01", active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

const lineOf = (text: string, start: string) => text.split("\n").find((line) => line.startsWith(start)) ?? null;

async function settle<T>(run: () => Promise<T>): Promise<{ value: T | null; threw: string }> {
  try {
    return { value: await run(), threw: "" };
  } catch (error) {
    return { value: null, threw: error instanceof Error ? error.name : String(error) };
  }
}

async function gifts(): Promise<void> {
  part("Gift receipt: the amount Stripe charged, or no amount line");
  const store = await freshStore();
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const product = (await readListing((await storeForEmail(OWNER))!, made.product.id)) as Listing;
  const give = async (n: number, over: Record<string, unknown>) => {
    const started = await startGift(store, product, { to: `friend${n}@example.com`, from: "Ana", message: "" });
    if (!started.ok) throw new Error("no gift");
    emails.length = 0;
    const session = {
      id: `cs_test_r48gift${n}${"g".repeat(16)}`,
      created: 1_900_000_000,
      amount_total: 3900,
      currency: "usd",
      payment_intent: `pi_R48Gift000${n}`,
      metadata: { store: "harbor", product: product.id, gift: started.gift.id },
      customer_details: { email: `buyer${n}@example.com` },
      ...over,
    };
    for (const key of Object.keys(over)) if (over[key] === undefined) delete (session as Record<string, unknown>)[key];
    const outcome = await deliverGift({
      store,
      session,
      product,
      base: "https://marktmorgen.com/@harbor",
      from: '"Harbor Kitchen" <hello@marktmorgen.com>',
      recordStart: async () => {},
      ordersLink: async () => null,
    });
    return { outcome, receipt: emails.find((e) => e.to[0] === `buyer${n}@example.com`)?.text ?? "" };
  };

  const healthy = await give(1, {});
  is("healthy: given, the receipt says what Stripe charged", [healthy.outcome, lineOf(healthy.receipt, "Paid:")], ["given", "Paid: $39"]);

  const noAmount = await give(2, { amount_total: undefined });
  is("no amount: still given, and a receipt goes", [noAmount.outcome, noAmount.receipt.includes("For: friend2@example.com")], ["given", true]);
  is("no amount: no amount line, never the catalog's $49", [lineOf(noAmount.receipt, "Paid:"), noAmount.receipt.includes("$49")], [null, false]);

  const textAmount = await give(3, { amount_total: "3900" });
  is("an amount in another shape: no amount line", lineOf(textAmount.receipt, "Paid:"), null);

  const noCurrency = await give(4, { currency: undefined });
  is("no currency: no amount line, never in the store's currency", lineOf(noCurrency.receipt, "Paid:"), null);
}

async function preorders(): Promise<void> {
  part("Pre-order receipt: held while the amount is unknown, sent once it is read");
  const store = {
    sid: "sidr48pre001", handle: "bakery", name: "Oven Notes", email: "owner@example.com", previousHandles: [], releasedHandles: [],
    statsId: "q".repeat(32), currency: "usd", language: "en", stripeAccountId: "acct_test_r48preorder1", pastBuyers: true,
  } as unknown as Store;
  const product = { id: "breadbookr48", title: "The Bread Book", priceCents: 2500, course: null } as unknown as Listing;
  const deps = {
    base: "https://marktmorgen.com/@bakery",
    from: "Oven Notes <hello@example.com>",
    ordersLink: async () => null,
    recordStart: async () => {},
  };
  redis.clear();
  redis.run(["SADD", `nl:wl:${store.statsId}:soon`, product.id]);
  const session = (n: number, over: Record<string, unknown>) => {
    const s: Record<string, unknown> = {
      id: `cs_test_r48preorder000${n}`, created: 1_794_000_000, status: "complete", payment_status: "paid", amount_total: 1900, currency: "usd",
      payment_intent: `pi_r48preorder000${n}`, metadata: { store: "bakery", product: product.id, preorder: "yes" }, customer_details: { email: `ana${n}@example.com` }, ...over,
    };
    for (const key of Object.keys(over)) if (over[key] === undefined) delete s[key];
    return s as Parameters<typeof confirmPreorder>[1];
  };
  const confirm = async (n: number, over: Record<string, unknown>) => {
    emails.length = 0;
    const outcome = await confirmPreorder(store, session(n, over), product, deps);
    return { outcome, receipt: emails.find((e) => e.to[0] === `ana${n}@example.com`)?.text ?? "" };
  };

  const healthy = await confirm(1, {});
  is("healthy: sent, with what Stripe charged", [healthy.outcome, healthy.receipt.includes("$19"), healthy.receipt.includes("$25")], ["sent", true, false]);

  const noAmount = await confirm(2, { amount_total: undefined });
  is("no amount: held (\"failed\"), no email at all, never the catalog's $25", [noAmount.outcome, emails.length], ["failed", 0]);
  const retried = await confirm(2, {});
  is("the next pass, the checkout read again: sent with what Stripe charged", [retried.outcome, retried.receipt.includes("$19")], ["sent", true]);

  const negative = await confirm(3, { amount_total: -1 });
  is("an amount below zero: held", [negative.outcome, emails.length], ["failed", 0]);
  const noCurrency = await confirm(4, { currency: undefined });
  is("no currency: held, never in the store's currency", [noCurrency.outcome, emails.length], ["failed", 0]);
  const oddCurrency = await confirm(5, { currency: "US Dollar" });
  is("a currency in another shape: held", [oddCurrency.outcome, emails.length], ["failed", 0]);
}

async function requests(): Promise<void> {
  part("Payment request: never written down as paid at a guessed amount");
  const store = await freshStore();
  const now = Date.now();
  const open = async (amount: string) => {
    const draft = readDraft({ email: "client@example.com", name: "Client", lines: [{ text: "Consulting hour", quantity: 1, amount }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now);
    if (!draft.ok) throw new Error("synthetic draft refused");
    const created = await createRequest(store, draft.draft, now);
    if (!created.ok) throw new Error(`synthetic request refused: ${created.reason}`);
    return created.request;
  };
  const unknown = await open("100");
  const noAmount = await settle(() => markPaid(store, unknown.id, { id: "cs_test_r48request00000001", payment_intent: "pi_r48request0001", created: Math.floor(now / 1000) }, now));
  is("no amount: refused as unknown", noAmount.threw, "UnknownReplyError");
  is("and the request stays open, nothing written as paid", [(await requestOf(store, unknown.id))?.state, (await requestOf(store, unknown.id))?.amountPaid], ["open", 0]);
  const textAmount = await settle(() => markPaid(store, unknown.id, { id: "cs_test_r48request00000001", amount_total: "10825" }, now));
  is("an amount in another shape: refused as unknown, still open", [textAmount.threw, (await requestOf(store, unknown.id))?.state], ["UnknownReplyError", "open"]);
  const read = await markPaid(store, unknown.id, { id: "cs_test_r48request00000001", payment_intent: "pi_r48request0001", amount_total: 10825, created: Math.floor(now / 1000) }, now);
  is("read exactly on the next pass: paid at what Stripe took", [read?.fresh, read?.request.state, read?.request.amountPaid], [true, "paid", 10825]);
  const again = await markPaid(store, unknown.id, { id: "cs_test_r48request00000001" }, now);
  is("already paid: answered as it is, whatever the reply", [again?.fresh, again?.request.amountPaid], [false, 10825]);

  part("Payment request receipt: tax added on top is shown, with the total");
  emails.length = 0;
  const send = (request: NonNullable<typeof read>["request"], language = "en") =>
    sendReceipt({ store: { ...store, language } as Store, request, base: "https://marktmorgen.com/@harbor", from: "Harbor Kitchen <harbor@marktmorgen.com>", idempotencyKey: `r48-${language}-${request.id}` });
  is("sent", await send(read!.request), true);
  const taxed = emails.at(-1)?.text.split("\n") ?? [];
  const at = taxed.indexOf("- Consulting hour: $100");
  is("the line, then the tax, then the total", taxed.slice(at, at + 3), ["- Consulting hour: $100", "Sales tax or VAT: $8.25", "Total: $108.25"]);
  for (const code of LANGUAGE_CODES) {
    emails.length = 0;
    await sendReceipt({ store: { ...store, language: code } as Store, request: read!.request, base: "https://marktmorgen.com/@harbor", from: "Harbor Kitchen <harbor@marktmorgen.com>", idempotencyKey: `r48-language-${code}` });
    const text = emails.at(-1)?.text ?? "";
    const w = REQUEST_WORDS[code];
    const said = speechFor(code, "usd");
    const tax = (w as { receiptTax?: (amount: string) => string }).receiptTax;
    is(`${code}: the tax line and the total line`, [Boolean(tax && text.includes(tax(said.money(825)))), text.includes(w.emailTotal(said.money(10825)))], [true, true]);
  }

  const plain = await open("100");
  const paidPlain = await markPaid(store, plain.id, { id: "cs_test_r48request00000002", payment_intent: "pi_r48request0002", amount_total: 10000, created: Math.floor(now / 1000) }, now);
  emails.length = 0;
  await send(paidPlain!.request);
  const untaxed = emails.at(-1)?.text.split("\n") ?? [];
  const where = untaxed.indexOf("- Consulting hour: $100");
  is("no tax on top: unchanged, the line then a blank line", [where >= 0, untaxed[where + 1], untaxed.some((l) => l.startsWith("Total:") || l.startsWith("Sales tax"))], [true, "", false]);
}

async function sales(): Promise<void> {
  part("The creator's \"New sale\" line: the amount Stripe charged, or none");
  let store = await freshStore();
  await setChatAddress(store.statsId!, "Harbor Kitchen", SLACK);
  await setChatSales(OWNER, true);
  store = (await storeForEmail(OWNER))!;
  const sale = (n: number, over: Record<string, unknown>): SaleRecord => {
    const r: Record<string, unknown> = {
      id: `cs_test_r48sale${n}${"s".repeat(12)}`, status: "complete", payment_status: "paid", mode: "payment", amount_total: 2900, currency: "usd",
      created: Math.floor(Date.now() / 1000) - 60, metadata: { store: "harbor", product: "p_r48", title: "Weeknight Club" }, ...over,
    };
    for (const key of Object.keys(over)) if (over[key] === undefined) delete r[key];
    return r as SaleRecord;
  };
  posted.length = 0;
  await noteSales(store, [sale(1, {})]);
  is("healthy: the amount", posted, ["New sale on Harbor Kitchen: $29, Weeknight Club"]);
  posted.length = 0;
  await noteSales(store, [sale(2, { amount_total: undefined })]);
  is("no amount: no amount, never $0", posted, ["New sale on Harbor Kitchen: Weeknight Club"]);
  posted.length = 0;
  await noteSales(store, [sale(3, { currency: undefined })]);
  is("no currency: no amount, never in the store's currency", posted, ["New sale on Harbor Kitchen: Weeknight Club"]);

  const offer = { id: "p_r48offer", title: "Meal Planner" } as unknown as Listing;
  posted.length = 0;
  await noteOfferSale(store, offer, { id: "pi_r48offer0001", amount: 1500, currency: "usd" });
  is("an offer after paying, healthy: the amount", posted, ["New sale on Harbor Kitchen: $15, Meal Planner (one-click offer)"]);
  posted.length = 0;
  await noteOfferSale(store, offer, { id: "pi_r48offer0002", currency: "usd" });
  is("an offer after paying, no amount: no amount, never $0", posted, ["New sale on Harbor Kitchen: Meal Planner (one-click offer)"]);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r48_receipts_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_only";
  process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
  console.error = () => {};
  await gifts();
  await preorders();
  await requests();
  await sales();
  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
