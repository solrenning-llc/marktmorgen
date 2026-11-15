/**
 * After a plan refund, endPlanNow (lib/plan-refund-flow.ts) ends the subscription and voids its open invoices and
 * deletes its drafts, so nothing of the refunded plan is left payable. A page of invoices that does not read (its
 * `data` not a list, a row with no id, a row of another status than the one asked for) proved nothing about what is
 * still open, yet the plan was taken as ended with no invoice voided (Claude 2 nuvem A's reading of the refund code,
 * 12/11/2026; rule 24). It is unknown now: false, so the note stays for the daily job. Synthetic Stripe only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { endPlanNow } from "@/lib/plan-refund-flow";
import type { Store } from "@/lib/store";

const SUB = "sub_EndExact00001";
let openPage: unknown = { object: "list", data: [], has_more: false };
const calls: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  calls.push(`${method} ${url.pathname}`);
  if (url.pathname === `/v1/subscriptions/${SUB}`) return json({ id: SUB, object: "subscription", status: "canceled" });
  if (url.pathname === "/v1/invoices" && method === "GET") {
    return url.searchParams.get("status") === "open" ? json(openPage) : json({ object: "list", data: [], has_more: false });
  }
  if (/^\/v1\/invoices\/in_[A-Za-z0-9]+\/void$/.test(url.pathname)) return json({ id: url.pathname.split("/")[3], object: "invoice", status: "void" });
  return json({ error: { message: `no stand-in for ${method} ${url.pathname}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  // A store this subscription is no longer written on: only the Stripe side of the ending is looked at here.
  const store = { sid: "end-exact-store", email: "owner@example.com", extra: false, subscriptionId: "sub_Another0000001", subscriptionActive: false, assistantPlan: null } as unknown as Store;
  const voids = () => calls.filter((c) => c.endsWith("/void")).length;

  part("Control: a page that reads, with one open invoice");
  openPage = { object: "list", data: [{ id: "in_Open00000001", object: "invoice", status: "open" }], has_more: false };
  calls.length = 0;
  is("ended, its open invoice voided", [await endPlanNow(store, SUB), voids()], [true, 1]);

  part("A page of open invoices that does not read is unknown: not ended");
  const bad: [string, unknown][] = [
    ["data is not a list", { object: "list", data: "garbled", has_more: false }],
    ["a row with no id", { object: "list", data: [{ object: "invoice", status: "open" }], has_more: false }],
    ["a row of another status than asked", { object: "list", data: [{ id: "in_Draft0000001", object: "invoice", status: "draft" }], has_more: false }],
    ["a row that is not an object", { object: "list", data: [null], has_more: false }],
  ];
  for (const [what, page] of bad) {
    openPage = page;
    calls.length = 0;
    is(`${what}: not taken as ended, nothing voided`, [await endPlanNow(store, SUB), voids()], [false, 0]);
  }
  done();
}

void main();
