/**
 * The closing day's end of every membership a store sold reads Stripe's
 * search exactly (queue item 307 [EC1], part 3; CX-123 rules 24 and 30, the
 * same class as eachSold in lib/closing-holds.ts, Claude 6 on #3108).
 *
 * Before, lib/closed-store-data.ts stopRenewals took a search page with no
 * data list as a page with no subscription, and a page that did not say
 * exactly whether more follow (has_more missing, or true with no next_page)
 * as the last page, and answered done. lib/plan-closing.ts closingDay then
 * wrote the renewals down as stopped and never asked again: the store's
 * members went on being charged on the creator's account for a store that
 * no longer exists.
 *
 * Now such a page answers not done, so the closing day is held and the
 * search read again the next run. Synthetic data only, a stand-in Stripe.
 */
import { stopRenewals } from "@/lib/closed-store-data";
import { claimHandle, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let page: (url: URL) => unknown = () => ({});
const deleted: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions/search") return Response.json(page(url));
  if (init?.method === "DELETE" && path.startsWith("/subscriptions/")) {
    const id = decodeURIComponent(path.slice("/subscriptions/".length));
    deleted.push(id);
    return Response.json({ id, object: "subscription", status: "canceled" });
  }
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

const live = (id: string) => ({ id, object: "subscription", status: "active", metadata: { store: "stopexact" } });

const outcome = (run: () => Promise<{ done: boolean }>) =>
  run().then(
    (value) => ({ settled: true, done: value.done }),
    () => ({ settled: false, done: false }),
  );

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_stop_renewals_exact_synthetic";
  redis.clear();
  await claimHandle("stop-exact@example.com", "stopexact", "Stop fixture", "");
  const shop = (await storeForEmail("stop-exact@example.com"))!;
  const store: Store = { ...shop, stripeAccountId: "acct_stopexact" };

  part("control: a whole page Stripe says is the last stops every live membership and is done");
  deleted.length = 0;
  page = () => ({ object: "search_result", data: [live("sub_stopexact01")], has_more: false, next_page: null });
  const whole = await stopRenewals(store, Number.POSITIVE_INFINITY);
  is("done", whole.done, true);
  is("the membership was ended", deleted, ["sub_stopexact01"]);

  const shapes: [string, unknown][] = [
    ["a page with no data list", { object: "search_result", has_more: false }],
    ["a page whose data is null", { object: "search_result", data: null, has_more: false }],
    ["a JSON null", null],
    ["a page that does not say whether more follow", { object: "search_result", data: [live("sub_stopexact02")] }],
    ["has_more as text", { object: "search_result", data: [live("sub_stopexact03")], has_more: "false" }],
    ["more to follow with no next page", { object: "search_result", data: [live("sub_stopexact04")], has_more: true, next_page: null }],
  ];
  for (const [label, reply] of shapes) {
    part(`Stripe's search answered ${label}`);
    page = () => reply;
    // Either a throw (closingDay holds on it) or done false: never done, which writes the renewals down as stopped.
    const got = await outcome(() => stopRenewals(store, Number.POSITIVE_INFINITY));
    is("never done: the closing day is held and the search read again", got.settled && got.done, false);
  }

  part("a second page after a first that read");
  deleted.length = 0;
  page = (url) =>
    url.searchParams.get("page")
      ? { object: "search_result", has_more: false }
      : { object: "search_result", data: [live("sub_stopexact05")], has_more: true, next_page: "next_stopexact" };
  const second = await outcome(() => stopRenewals(store, Number.POSITIVE_INFINITY));
  is("a second page with no data list is never the end", second.settled && second.done, false);
  done();
}

void main();
