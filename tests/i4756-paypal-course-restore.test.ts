/**
 * Issue #4756 (erasure, MEDIUM), the course half: when the PayPal refund reconciler (lib/paypal-sales.ts) finds a
 * second payment that keeps a course bought twice, it puts the course back first (restoreStart, an HSETNX) and then
 * the grant. An erasure that ran between its read and that course write was undone: the erased person's course and
 * its "no end" mark came back. The course is now put back only while the person has no deletion mark on the store's
 * list (lib/learn.ts restoreOpenEnrollment), or for a payment made after the mark. Synthetic only.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureListId, ensureStatsId, addProduct, setProductCourse, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { newCourseId } from "@/lib/course";
import { emailKey, storeKey } from "@/lib/learn";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

let buyerFor = "a@example.com";
/** Captures PayPal answers as refunded in full. */
const refunded = new Set<string>();
const override = new Map<string, Record<string, unknown>>();
const captureOf = (order: string) => `3C679366HH9087${order.slice(-2)}`;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
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
    const body = completed(capture, "49.00", buyerFor);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    if (override.has(cap)) return json(override.get(cap));
    return json({ id: cap, status: refunded.has(cap) ? "REFUNDED" : "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));


const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  await setPayPalSeller("owner@example.com", SELLER);
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const real = redis.pipeline.bind(redis);

  /** A course bought twice by `buyer`, the first payment then refunded in full. */
  async function boughtTwice(buyer: string, title: string) {
    const added = await addProduct("owner@example.com", title, "", "49", null);
    if (!added.ok) throw new Error("no product");
    const made = await setProductCourse("owner@example.com", added.product.id, { id: newCourseId(), lessons: 1 });
    if (!made.ok) throw new Error("no course");
    const store = await fresh();
    const product = (await readListing(store, added.product.id))!;
    if (!product.course) throw new Error("not a course");
    const orderIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
      if (!opened.ok) throw new Error("no order");
      buyerFor = buyer;
      await returnFor(store, opened.order);
      orderIds.push(opened.order);
    }
    refunded.add(captureOf(orderIds[0]));
    const ledger = `nl:learn:enr:${storeKey(store)}:${emailKey(buyer)}`;
    return { id: added.product.id, ledger };
  }
  const isCourseWrite = (commands: Commands, ledger: string) =>
    commands.length === 1 && commands[0][0] === "EVAL" && commands[0].includes("HSETNX") && commands[0].includes(ledger);
  const sweepTwice = async () => {
    for (let i = 0; i < 2; i += 1) { ahead += 3_600_000; await sweepPayPal(await fresh(), Date.now() + 10_000); }
  };

  part("the person is erased between the reconciler's read and its course write");
  const erasedBuyer = "course-twice@example.com";
  const one = await boughtTwice(erasedBuyer, "Sourdough Course");
  is("(control) the course was handed over", typeof (await real([["HGET", one.ledger, one.id]]))[0], "string");
  let erased = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!erased && isCourseWrite(commands, one.ledger)) {
      erased = true;
      redis.pipeline = real;
      const r = await erasePerson(await fresh(), erasedBuyer, { kind: "person" });
      if (!r.ok) throw new Error("erasure not ok");
      redis.pipeline = hooked;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const hooked = redis.pipeline;
  await sweepTwice();
  redis.pipeline = real;
  is("(control) the erasure ran just before the course write", erased, true);
  is("the erased person's course stays absent", (await real([["HEXISTS", one.ledger, one.id]]))[0], 0);
  is("and so does its no-end mark", (await real([["HEXISTS", one.ledger, `${one.id}:open`]]))[0], 0);

  part("a person erased before both payments still gets the course that stands");
  const laterBuyer = "came-back@example.com";
  const listId = (await fresh()).listId!;
  // A deletion mark from long before (lib/suppression.ts: the second it was written), as an erasure years ago leaves.
  await real([["HSET", suppressedKey(listId), suppressionPrint(listId, laterBuyer), "1000000000"]]);
  const two = await boughtTwice(laterBuyer, "Rye Course");
  await real([["HDEL", two.ledger, two.id, `${two.id}:open`]]);
  await sweepTwice();
  is("the course is put back for the payment that stands", typeof (await real([["HGET", two.ledger, two.id]]))[0], "string");

  part("(control) with no erasure, the course of the payment that stands is put back");
  const plainBuyer = "plain-twice@example.com";
  const three = await boughtTwice(plainBuyer, "Bagel Course");
  await real([["HDEL", three.ledger, three.id, `${three.id}:open`]]);
  await sweepTwice();
  is("the course is put back", typeof (await real([["HGET", three.ledger, three.id]]))[0], "string");
  done();
}
main().catch((error) => { console.log(String(error?.stack ?? error)); process.exit(1); });
