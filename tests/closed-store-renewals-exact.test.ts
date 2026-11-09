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

// Synthetic and shorter than 16 characters after the prefix, so the public data check (scripts/check_public_data.py,
// provider-account) does not take it for a real Stripe account id; it still matches STRIPE_ACCOUNT_PATTERN (lib/store.ts).
const ACCOUNT = "acct_1RenewExact01";
const HANDLE = "renewals-exact";
const MEMBER = "sub_RenewalsMember01";
const SECOND = "sub_RenewalsMember02";

/** What the search answers, page by page (the `page` cursor names the next one). */
let pages: Record<string, unknown> = {};
const deleted: string[] = [];
let searches = 0;
/**
 * A store's subscriptions as Stripe keeps them, when set: the search reads its
 * query (Stripe's search query language: clauses joined by AND, a clause
 * negated by a leading "-"), a DELETE ends one, and pages are cut either by a
 * cursor that stays put ("cursor") or by an offset into what the query matches
 * now ("offset"), so a page can be cut short by the ones that just left it.
 */
let world: { id: string; status: string; handle: string }[] | null = null;
let paging: "cursor" | "offset" = "cursor";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "DELETE" && path.startsWith("/subscriptions/")) {
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    deleted.push(id);
    const sub = world?.find((s) => s.id === id);
    if (sub) sub.status = "canceled";
    return json({ id, object: "subscription", status: "canceled" });
  }
  if (method === "GET" && path === "/subscriptions/search") {
    searches += 1;
    const page = url.searchParams.get("page") ?? "";
    if (world) return json(...worldPage(world, url.searchParams.get("query") ?? "", page, Number(url.searchParams.get("limit"))));
    return json(Object.hasOwn(pages, page) ? pages[page] : { object: "search_result", data: [], has_more: false, next_page: null });
  }
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** One page of what the query matches in `world`, or Stripe's 400 for a clause it does not take. */
function worldPage(subs: NonNullable<typeof world>, query: string, page: string, limit: number): [unknown, number] {
  let handle: string | null = null;
  const left = new Set<string>();
  for (const clause of query.split(" AND ")) {
    const store = /^metadata\['store'\]:'([^']+)'$/.exec(clause);
    const not = /^-status:'([a-z_]+)'$/.exec(clause);
    if (store && handle === null) handle = store[1];
    else if (not) left.add(not[1]);
    else return [{ error: { type: "invalid_request_error", message: `bad clause ${clause}` } }, 400];
  }
  if (handle === null || !(limit >= 1 && limit <= 100)) return [{ error: { type: "invalid_request_error", message: "bad search" } }, 400];
  const match = subs.filter((s) => s.handle === handle && !left.has(s.status));
  const at = new Map(subs.map((s, i) => [s.id, i]));
  let from = 0;
  if (page && paging === "offset") from = Number(page.slice(1));
  else if (page) from = match.findIndex((s) => at.get(s.id)! > (at.get(page) ?? Infinity));
  if (from < 0) from = match.length;
  const data = match.slice(from, from + limit).map((s) => member(s.id, s.status, s.handle));
  const more = from + limit < match.length;
  const next = !more ? null : paging === "offset" ? `o${from + limit}` : data[data.length - 1].id;
  return [{ object: "search_result", data, has_more: more, next_page: next }, 200];
}

const store = { handle: HANDLE, previousHandles: [], releasedHandles: [], stripeAccountId: ACCOUNT } as unknown as Store;
const member = (id: string, status = "active", handle = HANDLE) => ({ id, object: "subscription", status, metadata: { store: handle } });
const lastPage = (data: unknown[]) => ({ object: "search_result", data, has_more: false, next_page: null });

async function run(given: Record<string, unknown>) {
  world = null;
  pages = given;
  deleted.length = 0;
  searches = 0;
  const result = await stopRenewals(store, Date.now() + 10_000).then((r) => r, () => null);
  return { done: result?.done === true, deleted: [...deleted] };
}

/**
 * Closing-day runs over `world` until one says done or `most` have run: how
 * many ran, the most searches one run made, whether a run said done while a
 * member still ran, and how many still run at the end.
 */
async function runs(subs: NonNullable<typeof world>, how: typeof paging, most: number) {
  world = subs;
  paging = how;
  deleted.length = 0;
  let ran = 0, mostSearches = 0, doneTooEarly = false, finished = false;
  while (ran < most && !finished) {
    searches = 0;
    const result = await stopRenewals(store, Date.now() + 60_000).then((r) => r, () => null);
    ran += 1;
    mostSearches = Math.max(mostSearches, searches);
    finished = result?.done === true;
    if (finished && subs.some((s) => !["canceled", "incomplete_expired"].includes(s.status))) doneTooEarly = true;
  }
  const running = subs.filter((s) => !["canceled", "incomplete_expired"].includes(s.status)).length;
  world = null;
  return { finished, ran, mostSearches, doneTooEarly, running };
}
const many = (count: number, status: string, tag: string) =>
  Array.from({ length: count }, (_, i) => ({ id: `sub_${tag}${String(i).padStart(5, "0")}`, status, handle: HANDLE }));

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
    // Rule 23: was { done: true, ... } on this one run. A search of several pages that took members out has not been
    // seen to leave none (a page may be cut short by the ones that just left it): the next run must find none first.
    is("two pages read: both members ended, not done yet", r, { done: false, deleted: [MEMBER, SECOND] });
    const again = await run({ "": lastPage([]) });
    is("the next run's search finds none: done, nothing more ended", again, { done: true, deleted: [] });
  }
  {
    // Every page says more follow: the pass stops at its round limit, never done.
    const endless: Record<string, unknown> = { "": { object: "search_result", data: [], has_more: true, next_page: "again" }, again: { object: "search_result", data: [], has_more: true, next_page: "again" } };
    const r = await run(endless);
    is("a search that never reaches its end within the run: not done", r.done, false);
    is("and the run is bounded", searches <= 50, true);
  }

  part("A store with more than 50 pages of ended subscriptions still finishes its day (Claude 2 on #3332)");
  {
    // 51 full pages of long-canceled and expired ones, then the one member still running. Until 9 November 2026 the
    // search asked for every one the store ever sold, read the same first 50 pages on every run and never reached the
    // end: the day was held for good, its member never stopped, and every run spent 50 searches for nothing.
    const subs = [...many(5_000, "canceled", "Old"), ...many(100, "incomplete_expired", "Exp"), { id: "sub_StillRunning01", status: "active", handle: HANDLE }];
    const r = await runs(subs, "cursor", 5);
    is("the day finishes, its running member stopped, in one run with one search", { finished: r.finished, ran: r.ran, mostSearches: r.mostSearches, running: r.running }, { finished: true, ran: 1, mostSearches: 1, running: 0 });
  }

  part("5,000 running members: every one stopped in a bounded number of runs, never done while one runs");
  {
    const r = await runs(many(5_000, "active", "Live"), "cursor", 5);
    // The run that stops 50 pages of them reaches the end, but a run that took members out of a search of several
    // pages has not been seen to leave none: the next run's search finds none, and only then is the day done.
    is("pages that stay put: done on the second run, at most 50 searches a run", r, { finished: true, ran: 2, mostSearches: 50, doneTooEarly: false, running: 0 });
  }
  {
    const r = await runs(many(5_001, "active", "Live"), "cursor", 5);
    is("one more than 50 pages hold: done on the second run", r, { finished: true, ran: 2, mostSearches: 50, doneTooEarly: false, running: 0 });
  }
  {
    // A page cut by an offset into what the search matches now skips the ones that moved up when the stopped ones
    // left it: the pass reaches an end with members still running, and that end is never taken for the last.
    const r = await runs(many(5_000, "active", "Live"), "offset", 12);
    is("pages that shift as stopped ones leave: never done while one runs", r.doneTooEarly, false);
    is("and every one is stopped, in 6 runs", { finished: r.finished, running: r.running, ran: r.ran }, { finished: true, running: 0, ran: 6 });
    is("at most 50 searches a run", r.mostSearches <= 50, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
