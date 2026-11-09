/**
 * A closing store's members' renewals are stopped (lib/closed-store-data.ts,
 * stopRenewals), and the pass is said to be done only when Stripe's search of
 * every handle was read to its end, in its exact shape (rule 24/30;
 * lib/stripe-list.ts, readStripePage). Before this test, a search reply with
 * no `data` list was read as "nothing to stop": the closing day wrote its
 * `renewals` mark and never asked again, and the members' subscriptions went
 * on charging after the store closed. A page that does not say exactly
 * whether more follow, a row that cannot be read, or a run of pages that does
 * not reach the end are unknown too: the pass is not done, and the next run
 * asks again. A row the search gave for another handle is never ended.
 * Checked against a stand-in for Stripe; nothing real is reached.
 */
import "./redis-stub";
import { done, is, part } from "./check";
import { stopRenewals } from "@/lib/closed-store-data";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_closed_store_renewals_exact_only";

const ACCOUNT = "acct_1RenewalsExact01";
const HANDLE = "renewals-exact";
const MEMBER = "sub_RenewalsMember01";
const SECOND = "sub_RenewalsMember02";

/** What the search answers, page by page (the `page` cursor names the next one). */
let pages: Record<string, unknown> = {};
const deleted: string[] = [];
let searches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "DELETE" && path.startsWith("/subscriptions/")) {
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    deleted.push(id);
    return json({ id, object: "subscription", status: "canceled" });
  }
  if (method === "GET" && path === "/subscriptions/search") {
    searches += 1;
    const page = url.searchParams.get("page") ?? "";
    return json(Object.hasOwn(pages, page) ? pages[page] : { object: "search_result", data: [], has_more: false, next_page: null });
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const store = { handle: HANDLE, previousHandles: [], releasedHandles: [], stripeAccountId: ACCOUNT } as unknown as Store;
const member = (id: string, status = "active", handle = HANDLE) => ({ id, object: "subscription", status, metadata: { store: handle } });
const lastPage = (data: unknown[]) => ({ object: "search_result", data, has_more: false, next_page: null });

async function run(given: Record<string, unknown>) {
  pages = given;
  deleted.length = 0;
  searches = 0;
  const result = await stopRenewals(store, Date.now() + 10_000).then((r) => r, () => null);
  return { done: result?.done === true, deleted: [...deleted] };
}

async function main() {
  part("A search read to its end, every row readable: done, every running member stopped");
  {
    const r = await run({ "": lastPage([member(MEMBER), member(SECOND, "canceled")]) });
    is("done, and only the running one is ended", r, { done: true, deleted: [MEMBER] });
  }

  part("A search reply that is not a list is never 'nothing to stop'");
  for (const [label, body] of [
    ["no data", { object: "search_result", has_more: false, next_page: null }],
    ["data as an object", { object: "search_result", data: {}, has_more: false, next_page: null }],
    ["an empty object", {}],
    ["null", null],
    ["a list in place of the page", [member(MEMBER)]],
  ] as const) {
    const r = await run({ "": body });
    is(`a search answered with ${label}: the pass is not done`, r.done, false);
  }

  part("A search page that does not say exactly whether more follow is never the last one");
  for (const [label, body] of [
    ["no has_more", { object: "search_result", data: [member(MEMBER)], next_page: null }],
    ["has_more as a string", { object: "search_result", data: [member(MEMBER)], has_more: "false", next_page: null }],
  ] as const) {
    const r = await run({ "": body });
    is(`a page with ${label}: the pass is not done`, r.done, false);
  }
  {
    const r = await run({ "": { object: "search_result", data: [member(MEMBER)], has_more: true, next_page: null } });
    is("a page with has_more true and no next_page: the pass is not done, and its member is still stopped", r, { done: false, deleted: [MEMBER] });
  }

  part("A row that cannot be read is never skipped as nothing to stop");
  for (const [label, row] of [
    ["null", null],
    ["a string", SECOND],
    ["with no id", { object: "subscription", status: "active", metadata: { store: HANDLE } }],
    ["with no status", { id: SECOND, object: "subscription", metadata: { store: HANDLE } }],
  ] as const) {
    const r = await run({ "": lastPage([member(MEMBER), row]) });
    is(`a row that is ${label}: the pass is not done, and the readable member is still stopped`, r, { done: false, deleted: [MEMBER] });
  }

  part("A row the search gave for another handle is never ended");
  {
    const r = await run({ "": lastPage([member(MEMBER), member(SECOND, "active", "another-store")]) });
    is("only this store's member is ended; the pass is done", r, { done: true, deleted: [MEMBER] });
  }

  part("Pages followed to the end; a run that stops before the end is not done");
  {
    const r = await run({ "": { object: "search_result", data: [member(MEMBER)], has_more: true, next_page: "p2" }, p2: lastPage([member(SECOND)]) });
    is("two pages read: both members ended, done", r, { done: true, deleted: [MEMBER, SECOND] });
  }
  {
    // Every page says more follow: the pass stops at its round limit, never done.
    const endless: Record<string, unknown> = { "": { object: "search_result", data: [], has_more: true, next_page: "again" }, again: { object: "search_result", data: [], has_more: true, next_page: "again" } };
    const r = await run(endless);
    is("a search that never reaches its end within the run: not done", r.done, false);
    is("and the run is bounded", searches <= 50, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
