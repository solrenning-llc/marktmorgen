import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as memory } from "./redis-stub";
import { done, is, part } from "./check";

const customer = "cus_member0001", id = "sub_live000001", promo = "promo_active0001";
const price = { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } };
const subscription = (p: unknown = price) => ({ id, status: "active", discounts: [], metadata: { store: "memberstore", product: "prod000001" }, items: { data: [{ price: p }] } });
const page = (data: unknown[]) => ({ object: "list", data, has_more: false });
let customers: unknown, subscriptions: unknown, posts = 0, postReply: unknown = { id };
const savedFetch = globalThis.fetch, savedKey = process.env.STRIPE_SECRET_KEY;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw Error("Unexpected provider");
  const reply = (v: unknown) => new Response(JSON.stringify(v));
  if (url.pathname === "/v1/customers") return reply(customers);
  if (url.pathname === "/v1/subscriptions") return reply(subscriptions);
  if (url.pathname === "/v1/promotion_codes") return reply(page([{ id: promo, code: "THANKS", active: true, promotion: { type: "coupon", coupon: { id: "co_1", percent_off: 20, duration: "once" } } }]));
  if (url.pathname === `/v1/subscriptions/${id}` && init?.method === "POST") { posts += 1; return reply(postReply); }
  throw Error("Unexpected Stripe operation");
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_member_discount_only";
  memory.clear();
  await claimHandle("member-discount@example.com", "memberstore", "Member Store", "");
  await setStripeAccount("member-discount@example.com", "acct_1Memberxxxxxxxx", true);
  const store = (await storeForEmail("member-discount@example.com"))!;
  const reset = () => { customers = page([{ id: customer }]); subscriptions = page([subscription()]); posts = 0; postReply = { id }; };
  async function refuses(name: string): Promise<void> {
    is(`${name}: the list is unknown`, await memberSubs(store, "member@example.com"), null);
    is(`${name}: no discount operation`, [await applyMemberDiscount(store, "member@example.com", id, promo), posts], [{ ok: false, reason: "stripe" }, 0]);
  }
  part("A partial member list never becomes an empty or actionable list");
  for (const target of ["customers", "subscriptions"]) for (const [name, response] of [
    ["missing data", {}], ["null data", { data: null, has_more: false }],
    ["missing completion", { data: [] }], ["partial page", { data: [], has_more: true }],
    ["partial page with a valid row", { data: target === "customers" ? [{ id: customer }] : [subscription()], has_more: true }],
    ["invalid row", page([{}])], ["null row", page([null])],
  ]) {
    reset(); if (target === "customers") customers = response; else subscriptions = response;
    await refuses(`${target}: ${name}`);
  }
  part("Unknown renewal money and intervals never become zero or blank");
  for (const [name, value] of [
    ["missing amount", undefined], ["null amount", null], ["text amount", "2900"],
    ["negative amount", -1], ["fractional amount", 2.5], ["unsafe amount", Number.MAX_SAFE_INTEGER + 1],
    ["NaN amount", NaN], ["infinite amount", Infinity],
  ] as const) { reset(); subscriptions = page([subscription({ ...price, unit_amount: value })]); await refuses(name); }
  for (const [name, p] of [
    ["missing currency", { ...price, currency: undefined }], ["empty currency", { ...price, currency: "" }],
    ["invalid currency", { ...price, currency: "dollars" }], ["missing interval", { ...price, recurring: {} }],
    ["unknown interval", { ...price, recurring: { interval: "decade" } }], ["missing price", null],
  ]) { reset(); subscriptions = page([subscription(p)]); await refuses(String(name)); }
  for (const [name, extra] of [
    ["missing status", { status: undefined }], ["unknown status", { status: "mystery" }],
    ["missing discount evidence", { discounts: undefined }], ["null discounts", { discounts: null }],
    ["unknown discount object", { discounts: [], discount: {} }], ["broken discount item", { discounts: [null] }],
  ] as const) { reset(); subscriptions = page([{ ...subscription(), ...extra }]); await refuses(String(name)); }
  part("Known absence and a genuine zero retain their existing meanings");
  reset(); customers = page([]);
  is("confirmed no customer is an empty membership list", await memberSubs(store, "member@example.com"), []);
  reset(); subscriptions = page([]);
  is("confirmed no subscriptions is an empty membership list", await memberSubs(store, "member@example.com"), []);
  reset(); subscriptions = page([subscription({ ...price, unit_amount: 0 })]);
  is("an explicit zero amount remains zero", (await memberSubs(store, "member@example.com"))?.[0]?.amount, 0);
  reset();
  is("known membership still accepts the existing code once", [await applyMemberDiscount(store, "member@example.com", id, promo), posts], [{ ok: true }, 1]);
  for (const value of [{}, { id: "sub_another0001" }, null]) {
    reset(); postReply = value;
    is("an unconfirmed update is not success and is never retried", [await applyMemberDiscount(store, "member@example.com", id, promo), posts], [{ ok: false, reason: "stripe" }, 1]);
  }
}
void main().finally(() => {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedKey;
}).then(done).catch(error => { console.error(error); process.exit(1); });
