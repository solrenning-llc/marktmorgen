/**
 * A PayPal payment for a product the creator removed before it was handed over (owner's decision 2 of
 * C1-20261109-1029-C5-52). The refund itself is not automatic yet: the repository has no call to PayPal's refund of a
 * capture, and PayPal's official documentation was not readable here, so no integration that moves money is guessed.
 * What does not need that call is held here:
 *
 * - A capture PayPal answered COMPLETED (a written paid record), nothing handed over, and the product gone: the order
 *   is marked "refund owed" (lib/paypal-owed.ts), the creator is emailed once to refund it in PayPal, it leaves the
 *   hand-over list, and the buyer's page says the truth: the product is no longer available and the creator was asked
 *   to refund the payment. Before, it only left the list with a log line: nobody was told and the page said "handing
 *   it over" for ever.
 * - Asked again (a reload, a sweep, another try): no second email.
 * - A capture PayPal has not confirmed (PENDING): nothing is marked and nobody is emailed; the sweep settles it once
 *   PayPal completes it, and only then is it marked.
 * - A read that is unknown (the buyer's grant): nothing is marked, the order stays on the list, and the sweep tries
 *   again (CX-123 rule 24).
 * - An email the sender would not take: the order is marked, the page does not say the creator was asked, and the
 *   email is tried again later (not every run), inside a window; past it the order leaves the list marked.
 * - Handed over before the product was removed: never marked, nobody emailed.
 *
 * Synthetic only: a stand-in for PayPal's and Resend's APIs, the Redis stub, the real return route, the real sweep and
 * the real thanks page.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, removeProduct, setPayPalSeller, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { handOverKey, openOrder, readPaid } from "@/lib/paypal-sales";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { TELL_RETRY_SECONDS, TELL_TRIES_AT_MOST, TELL_WINDOW_SECONDS, owePayPalRefund } from "@/lib/paypal-owed";
import { readListing } from "@/lib/catalog";
import { importedKey } from "@/lib/imported-purchases";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { PAYPAL_REFUND_OWED } from "./plan-cost-registry";

const OWNER = "kiln@example.com";
const BASE = "https://marktmorgen.com";
const UNAVAILABLE = "This product is no longer available";
const HANDING_OVER = "Payment received, we&#x27;re handing it over";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `7R190127TN36473${String(n).padStart(2, "0")}`;
let buyerFor = "a@example.com";
let captureStatus: "COMPLETED" | "PENDING" = "COMPLETED";
let resendFails = false;
/** Every email the sender took: to whom, and its subject. */
const sent: { to: string; subject: string; text: string }[] = [];

function body(order: string, status: string): Record<string, unknown> {
  return {
    id: order,
    status: status === "COMPLETED" ? "COMPLETED" : "APPROVED",
    payer: { email_address: buyerFor, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `4D679366HH9088${order.slice(-2)}`, status, amount: { currency_code: "USD", value: "29.00" } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    if (resendFails) return json({ name: "validation_error" }, 422);
    const mail = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: Array.isArray(mail.to) ? String(mail.to[0]) : String(mail.to), subject: String(mail.subject ?? ""), text: String(mail.text ?? "") });
    return json({ id: `e${sent.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const answer = body(capture, captureStatus);
    orders.set(capture, answer);
    return json(answer, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`${BASE}/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));

/** The buyer's page for the order, as HTML. */
async function page(order: string): Promise<string> {
  answering(new Request(`${BASE}/@kilnworks/thanks?paypal=${order}`, { headers: { "x-forwarded-for": `203.0.113.${made}` } }));
  const outer = (await ThanksPage({ params: Promise.resolve({ handle: "@kilnworks" }), searchParams: Promise.resolve({ paypal: order }) })) as { type: (p: unknown) => Promise<unknown>; props: unknown };
  const tree = await outer.type(outer.props);
  const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** Makes every pipeline that touches a key matching `key` throw, as a Redis outage does; returns the undo. */
function failReadsOf(key: RegExp): () => void {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c.some((p) => key.test(String(p))))) throw new Error("redis unavailable");
    return real(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real;
  };
}

const owner = async () => (await storeForEmail(OWNER)) as Store;
/** Whether the order is marked "refund owed", read straight from the stub (null: not marked). */
async function owed(store: Store, order: string): Promise<boolean> {
  const [score] = await redis.pipeline([["ZSCORE", `nl:ppsell:owed:${store.statsId}`, order]]);
  return score !== null && score !== undefined;
}
async function onList(store: Store, order: string): Promise<boolean> {
  const [score] = await redis.pipeline([["ZSCORE", handOverKey(store.statsId!), order]]);
  return score !== null && score !== undefined;
}
/** The emails to the creator about refunding this order's payment. */
const told = (order: string) => sent.filter((m) => m.to === OWNER && m.text.includes(`4D679366HH9088${order.slice(-2)}`)).length;
/** Makes the order due at the next sweep (the sweep waits out the return's own hand-over first). */
const dueNow = async (store: Store, order: string) => redis.pipeline([["ZADD", handOverKey(store.statsId!), "XX", "0", order]]);
const sweep = async () => sweepPayPal(await owner(), Date.now() + 10_000);

/** A product added and opened for PayPal, then (when asked) removed before the buyer comes back. */
async function opened(title: string, buyer: string, remove: boolean): Promise<{ order: string; product: string }> {
  const added = await addProduct(OWNER, title, "", "29", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/file");
  const listing = (await readListing(await owner(), added.product.id))!;
  const open = await openOrder(await owner(), listing, BASE, { digitalConsent: TEST_CONSENT });
  if (!open.ok) throw new Error(`no order: ${open.reason}`);
  buyerFor = buyer;
  if (remove && !(await removeProduct(OWNER, added.product.id)).ok) throw new Error("not removed");
  return { order: open.order, product: added.product.id };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00002", subscriptionId: "sub_kiln00002", active: true, tier: "creator", period: paidPeriod() });
  process.env.RESEND_API_KEY = "re_test_only";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await setPayPalSeller(OWNER, SELLER);

  part("Captured (COMPLETED), the product removed before it was handed over");
  {
    const { order } = await opened("Glazing guide", "gone@example.com", true);
    await returnFor(await owner(), order);
    const store = await owner();
    is("the payment is written down as paid", Boolean(await readPaid(order)), true);
    is("nothing is granted to the buyer", (await redis.pipeline([["HLEN", importedKey(store.statsId!, "gone@example.com")]]))[0], 0);
    is("the order is marked refund owed", await owed(store, order), true);
    is("the creator is emailed once to refund it in PayPal", told(order), 1);
    const mail = sent.find((m) => m.to === OWNER && m.text.includes(`4D679366HH9088${order.slice(-2)}`));
    // Pre-review LEVE 5: the email said the buyer's page says "we asked you", which holds only once "sent" is written.
    is("the email claims nothing about the page that the page may not say", Boolean(mail && !mail.text.includes("that we asked you")), true);
    is("the email says what to do: refund the payment in PayPal, in full", [Boolean(mail && /refund/i.test(mail.subject)), Boolean(mail && /PayPal/.test(mail.text) && /in full/.test(mail.text))], [true, true]);
    is("no receipt goes to the buyer", sent.some((m) => m.to === "gone@example.com"), false);
    is("it leaves the hand-over list", await onList(store, order), false);
    const html = await page(order);
    is("the buyer's page says the product is no longer available", html.includes(UNAVAILABLE), true);
    is("and that the creator was asked to refund the payment", html.includes("asked Kiln Works to refund"), true);
    is("it no longer says the purchase is being handed over", html.includes(HANDING_OVER), false);

    part("Asked again: a reload, the sweep, another try");
    await returnFor(await owner(), order);
    await dueNow(store, order);
    await sweep();
    const paid = (await readPaid(order))!;
    await handOverPayPal(await owner(), paid);
    is("still one email to the creator", told(order), 1);
    is("still marked", await owed(store, order), true);
  }

  part("A capture PayPal has not confirmed (PENDING), the product removed");
  {
    captureStatus = "PENDING";
    const { order } = await opened("Clay notes", "pending@example.com", true);
    await returnFor(await owner(), order);
    captureStatus = "COMPLETED";
    const store = await owner();
    is("nothing is written down as paid", Boolean(await readPaid(order)), false);
    is("nothing is marked", await owed(store, order), false);
    is("nobody is emailed", told(order), 0);
    // PayPal completes it: the sweep settles it, and only then is it marked and the creator told.
    orders.set(order, body(order, "COMPLETED"));
    const swept = await sweep();
    is("once PayPal completes it, the sweep marks it", await owed(store, order), true);
    // Pre-review LEVE 6: the watch counted it as cleared (handed over) although nothing was handed over.
    is("it is not counted as handed over", swept.cleared, 0);
    is("and the creator is emailed once", told(order), 1);
    await dueNow(store, order);
    await sweep();
    is("a further sweep emails no more", told(order), 1);
  }

  part("The buyer's grant cannot be read: nothing marked, tried again");
  {
    const { order } = await opened("Kiln log", "unread@example.com", true);
    const undo = failReadsOf(/^nl:imp:buy:/);
    await returnFor(await owner(), order);
    undo();
    const store = await owner();
    is("paid", Boolean(await readPaid(order)), true);
    is("nothing is marked", await owed(store, order), false);
    is("nobody is emailed", told(order), 0);
    is("it stays on the hand-over list", await onList(store, order), true);
    await dueNow(store, order);
    await sweep();
    is("the read heals: the sweep marks it", await owed(store, order), true);
    is("and emails the creator once", told(order), 1);
    is("and it leaves the list", await onList(store, order), false);
  }

  // Changed after the RED commit (rule 23): this part first expected "nothing marked" while the email was not taken. The
  // mark now goes first, so the order is owed whatever the email does, and the page says the creator was asked only
  // once the email went; a refusal (422, which the sender confirms it did not take) is tried again later, not every run.
  part("The email to the creator is not taken: marked, the page does not say they were asked, tried again later");
  {
    const { order } = await opened("Firing chart", "refused@example.com", true);
    resendFails = true;
    await returnFor(await owner(), order);
    resendFails = false;
    const store = await owner();
    is("the order is marked refund owed", await owed(store, order), true);
    is("nobody is emailed yet", told(order), 0);
    is("it stays on the hand-over list", await onList(store, order), true);
    const [score] = await redis.pipeline([["ZSCORE", handOverKey(store.statsId!), order]]);
    const due = Number(score) + 600 - Math.floor(Date.now() / 1000);
    is("due again in about TELL_RETRY_SECONDS, not at the next run", due > TELL_RETRY_SECONDS - 120 && due <= TELL_RETRY_SECONDS, true);
    await sweep();
    is("the next run does not try it again", told(order), 0);
    const html = await page(order);
    is("the page says the product is no longer available", html.includes(UNAVAILABLE), true);
    is("it does not say the creator was asked", html.includes("asked Kiln Works to refund"), false);
    is("it says the payment is owed back, and how to ask for it", html.includes("This payment is owed back to you: ask Kiln Works for a refund"), true);
    await dueNow(store, order);
    await sweep();
    is("once due, the sweep emails the creator once", told(order), 1);
    is("and it leaves the list", await onList(store, order), false);
    is("the page now says the creator was asked", (await page(order)).includes("asked Kiln Works to refund"), true);
  }

  part("The email never taken inside the window: marked, no longer tried");
  {
    const { order } = await opened("Glaze tests", "never@example.com", true);
    resendFails = true;
    await returnFor(await owner(), order);
    const store = await owner();
    const paid = (await readPaid(order))!;
    is("tried once, not taken", [await owed(store, order), told(order), await onList(store, order)], [true, 0, true]);
    is("past the window it leaves the list, marked", await owePayPalRefund(store, paid, paid.at + TELL_WINDOW_SECONDS), "owed");
    resendFails = false;
    is("nobody was emailed", told(order), 0);
    is("the page does not say the creator was asked", (await page(order)).includes("asked Kiln Works to refund"), false);
    is("the tries are bounded", TELL_TRIES_AT_MOST, 13);
  }

  part("Cost: one try's own commands, and the first try against the hand-over it replaces");
  {
    // Each order's return-route hand-over is made to fail on its first step (the buyer's grant), so it stays on the
    // list with nothing done; then one hand-over is run and counted, as the sweep would run it.
    const fresh = async (title: string, buyer: string, remove: boolean) => {
      const made = await opened(title, buyer, remove);
      const undo = failReadsOf(/^nl:imp:buy:/);
      await returnFor(await owner(), made.order);
      undo();
      return (await readPaid(made.order))!;
    };
    const own = /^nl:ppsell:owed:|^nl:imp:buy:|^nl:ppsell:refunded:|^nl:ppsell:reversed:|^nl:ppsell:own:|^nl:ppsell:handover:/;
    const count = async (run: () => Promise<unknown>) => {
      const real = redis.pipeline.bind(redis);
      let all = 0;
      let mine = 0;
      redis.pipeline = (async (commands: (string | number)[][]) => {
        all += commands.length;
        mine += commands.filter((c) => c.some((p) => own.test(String(p)))).length;
        return real(commands);
      }) as typeof redis.pipeline;
      try {
        await run();
      } finally {
        redis.pipeline = real;
      }
      return { all, mine };
    };
    const healthy = await fresh("Healthy guide", "healthy@example.com", false);
    const atHealthy = await owner();
    const handOver = await count(() => handOverPayPal(atHealthy, healthy));
    const gone = await fresh("Gone guide", "gonecost@example.com", true);
    const atGone = await owner();
    const owedTry = await count(() => handOverPayPal(atGone, gone));
    const refused = await fresh("Refused guide", "refusedcost@example.com", true);
    const atRefused = await owner();
    resendFails = true;
    const refusedTry = await count(() => handOverPayPal(atRefused, refused));
    resendFails = false;
    console.log(`        commands: hand-over ${JSON.stringify(handOver)}, owed ${JSON.stringify(owedTry)}, refused ${JSON.stringify(refusedTry)}`);
    is("the healthy order was handed over, the others owed", [(await redis.pipeline([["HLEN", importedKey(healthy.store, "healthy@example.com")]]))[0], await owed(await owner(), gone.order), await owed(await owner(), refused.order)], [1, true, true]);
    // Less the list's own ZREM (listCommandsPerSale, PAYPAL_HAND_OVER_RETRY), which is not one of this try's own.
    is("a try's own commands stay within PAYPAL_REFUND_OWED.ownCommandsAtMost", [owedTry.mine - 1 <= PAYPAL_REFUND_OWED.ownCommandsAtMost, refusedTry.mine <= PAYPAL_REFUND_OWED.ownCommandsAtMost], [true, true]);
    is("the first try costs less than the hand-over it replaces", owedTry.all < handOver.all, true);
    is("the tries are those the registry states", PAYPAL_REFUND_OWED.triesAtMost, TELL_TRIES_AT_MOST);
  }

  part("Handed over, then the product removed: nothing owed");
  {
    const { order, product } = await opened("Glaze recipes", "kept@example.com", false);
    await returnFor(await owner(), order);
    const store = await owner();
    is("handed over", (await redis.pipeline([["HLEN", importedKey(store.statsId!, "kept@example.com")]]))[0], 1);
    await removeProduct(OWNER, product);
    // A list removal that did not land: the order is tried again after the product went.
    await redis.pipeline([["ZADD", handOverKey(store.statsId!), "0", order]]);
    await sweep();
    is("never marked", await owed(store, order), false);
    is("nobody emailed about a refund", told(order), 0);
    is("it leaves the list", await onList(store, order), false);
  }

  done();
}

void main();
