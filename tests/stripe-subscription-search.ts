/**
 * A stand-in for Stripe's subscription search over a store's subscriptions as
 * Stripe keeps them (synthetic only). It reads the query in Stripe's search
 * query language as the code sends it: clauses joined by " AND ", one
 * `metadata['store']:'<handle>'` and any number of `-status:'<status>'`
 * negations; any other clause is answered with Stripe's 400, so a test fails
 * when the code asks for something the stand-in does not understand.
 *
 * Pages are cut either by a cursor that stays put ("cursor": the next page
 * starts after the last row given) or by an offset into what the query
 * matches now ("offset"), so a page can be cut short, and a row skipped, when
 * rows before it leave the search between two pages.
 *
 * The same shape as the stand-in in tests/closed-store-renewals-exact.test.ts
 * (#3332, stopRenewals); once both are in main, that test can read this one.
 */
export type SearchPaging = "cursor" | "offset";
export type SearchRow = { id: string; status: string; handle: string };

export function subscriptionSearchPage<T extends SearchRow>(subs: T[], query: string, page: string, limit: number, paging: SearchPaging): [unknown, number] {
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
  const data = match.slice(from, from + limit);
  const more = from + limit < match.length;
  const next = !more ? null : paging === "offset" ? `o${from + limit}` : data[data.length - 1].id;
  return [{ object: "search_result", data, has_more: more, next_page: next }, 200];
}
