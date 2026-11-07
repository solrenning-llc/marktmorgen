/**
 * A store's renewals read page by page (lib/ad-events.ts, sendRenewals):
 * every renewal paid in the day reaches the ad platforms, however many there
 * are, not only the newest hundred.
 *
 *   - a second page is read with starting_after when Stripe says has_more;
 *   - a page that is not a list, a has_more that is neither true nor false,
 *     or a row that is not an object is not "no renewals": the pass throws,
 *     and the next one tries again;
 *   - at most RENEWAL_PAGES_PER_RUN pages a pass; past them, the place the
 *     pass stopped at is kept, the next pass goes on from it, and the pass
 *     after that reads from the newest again;
 *   - a pass that stops before handling what it read (its deadline) keeps
 *     the place where it was, so nothing read and not sent is passed over;
 *   - a kept place that is not an invoice's id is unknown: nothing is read.
 */
import * as ads from "@/lib/ad-events";
import { sendRenewals, setServerToken, subKey } from "@/lib/ad-events";
import { NO_PIXELS } from "@/lib/pixels";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_ad_renewals_pages_stand_in";

const OWNER = "pages@example.com";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);
const TOKENS = { meta: "EAAB" + "m".repeat(60), tiktok: "tt" + "t".repeat(40), google: "G00gleApiSecret_abcdefgh", pinterest: "pina_" + "p".repeat(50) };
const SUB = "sub_Club00000001";

let invoices: Record<string, unknown>[] = [];
/** What /invoices answers instead of the list, when set. */
let odd: ((page: { data: unknown[]; has_more: boolean }) => unknown) | null = null;
const asked: URLSearchParams[] = [];
let sentToMeta = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"].includes(url.hostname)) {
    if (url.hostname === "graph.facebook.com") sentToMeta += (JSON.parse(String(init?.body)).data as unknown[]).length;
    if (url.hostname === "business-api.tiktok.com") return json({ code: 0, message: "OK" });
    if (url.hostname === "www.google-analytics.com") return new Response(null, { status: 204 });
    return json({ events_received: 1 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/invoices") {
    asked.push(url.searchParams);
    // Stripe's list: newest first, a hundred at most, after the id given.
    const since = Number(url.searchParams.get("created[gte]"));
    const all = invoices.filter((row) => (row.created as number) >= since).sort((a, b) => (b.created as number) - (a.created as number));
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit"));
    const data = all.slice(from, from + limit);
    const page = { data, has_more: from + limit < all.length };
    return json(odd ? odd(page) : { object: "list", ...page });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The renewal paid `n` seconds before now, of a membership bought with the yes. */
const renewal = (n: number) => ({
  id: `in_Page${String(n).padStart(6, "0")}`,
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 4900,
  currency: "usd",
  customer_email: "member@example.com",
  created: SEC - n,
  status_transitions: { paid_at: SEC - n },
  parent: { subscription_details: { subscription: SUB, metadata: { store: "harbor", product: "club000001", ads: "a".repeat(24) } } },
});
const renewals = (count: number) => Array.from({ length: count }, (_, i) => renewal(i + 1));
const placeKey = (statsId: string) => `nl:adsrv:renew:${statsId}`;
const fresh = () => {
  for (const key of redis.keys().filter((k) => k.startsWith("nl:adsrv:sent:"))) redis.run(["DEL", key]);
  asked.length = 0;
  sentToMeta = 0;
  odd = null;
};

async function rejects(what: string, run: () => Promise<unknown>): Promise<void> {
  const got = await run().then(
    (value) => `answered ${JSON.stringify(value)}`,
    () => "threw",
  );
  is(what, got, "threw");
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0002", true);
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345", tiktok: "C4ABCDEFGH1234567890", google: "G-AB12CD34EF", pinterest: "2612345678901" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  for (const p of ["meta", "tiktok", "google", "pinterest"] as const) await setServerToken(statsId, p, TOKENS[p], { account: "549755885175" });
  await setAdsServer(OWNER, ["meta", "tiktok", "google", "pinterest"]);
  store = (await storeForEmail(OWNER))!;
  redis.run(["SET", subKey(SUB), JSON.stringify({ _fbp: "fb.1.1.1" }), "EX", 86400]);

  part("More than a hundred in a day");
  invoices = renewals(150);
  fresh();
  is("every one of the 150 is sent, not only the newest hundred", await sendRenewals(store, NOW), 150);
  is("to Meta, each once", sentToMeta, 150);
  is("two pages: the second after the first page's last invoice", asked.map((q) => q.get("starting_after")), [null, "in_Page000100"]);
  is("each page a hundred, paid, of the last day", asked.map((q) => [q.get("limit"), q.get("status"), q.get("created[gte]")]), [
    ["100", "paid", String(SEC - 86400)],
    ["100", "paid", String(SEC - 86400)],
  ]);
  is("nothing kept for the next pass: it reached the end", redis.run(["GET", placeKey(statsId)]), null);
  asked.length = 0;
  is("the next pass sends nothing again", await sendRenewals(store, NOW), 0);

  part("A page in an unknown shape is not an empty day");
  fresh();
  odd = () => ({ object: "list", data: { not: "a list" }, has_more: false });
  await rejects("data that is not a list throws, so the pass is said as failed", () => sendRenewals(store, NOW));
  is("nothing sent on it", sentToMeta, 0);
  odd = (page) => ({ object: "list", data: page.data });
  await rejects("a page without has_more throws", () => sendRenewals(store, NOW));
  odd = (page) => ({ object: "list", data: page.data, has_more: "true" });
  await rejects("a has_more that is not true or false throws", () => sendRenewals(store, NOW));
  odd = (page) => ({ object: "list", data: [null, ...page.data.slice(1)], has_more: page.has_more });
  await rejects("a row that is not an object throws", () => sendRenewals(store, NOW));
  odd = () => ({ object: "list", data: [], has_more: true });
  await rejects("more said to follow an empty page throws: there is no place to go on from", () => sendRenewals(store, NOW));
  is("and still nothing sent", sentToMeta, 0);
  is("nor a place kept", redis.run(["GET", placeKey(statsId)]), null);

  part("Past the pages one pass reads, the rest wait for the next pass");
  // Read through the module so the test runs, and fails, before the cap exists.
  is("three pages a pass", (ads as Record<string, unknown>).RENEWAL_PAGES_PER_RUN, 3);
  invoices = renewals(350);
  fresh();
  is("the first pass sends the newest three hundred", await sendRenewals(store, NOW), 300);
  is("it read three pages", asked.length, 3);
  is("and kept where it stopped", redis.run(["GET", placeKey(statsId)]), "in_Page000300");
  is("for an hour at the most", Number(redis.run(["TTL", placeKey(statsId)])) > 0 && Number(redis.run(["TTL", placeKey(statsId)])) <= 3600, true);
  asked.length = 0;
  is("the next pass goes on from there and sends the other fifty", await sendRenewals(store, NOW), 50);
  is("starting after the place kept", asked.map((q) => q.get("starting_after")), ["in_Page000300"]);
  is("and lets the place go, at the end", redis.run(["GET", placeKey(statsId)]), null);
  is("all 350 sent, each once", sentToMeta, 350);
  asked.length = 0;
  is("the pass after reads from the newest again, and sends nothing twice", await sendRenewals(store, NOW), 0);
  is("from the newest", asked[0]?.get("starting_after"), null);
  is("every one it read handled, it keeps its place after them, for the pass after", redis.run(["GET", placeKey(statsId)]), "in_Page000300");

  part("A pass that stops before it handled what it read keeps the place where it was");
  fresh();
  redis.run(["DEL", placeKey(statsId)]);
  is("its time already over: nothing sent", await sendRenewals(store, NOW, 0), 0);
  is("and no place kept past what it did not send", redis.run(["GET", placeKey(statsId)]), null);
  redis.run(["SET", placeKey(statsId), "in_Page000100", "EX", 3600]);
  is("nor moved from one kept before", await sendRenewals(store, NOW, 0), 0);
  is("still there", redis.run(["GET", placeKey(statsId)]), "in_Page000100");
  redis.run(["DEL", placeKey(statsId)]);

  part("A kept place that is not an invoice's id is unknown");
  fresh();
  redis.run(["SET", placeKey(statsId), "not-an-invoice", "EX", 3600]);
  await rejects("it throws", () => sendRenewals(store, NOW));
  is("before Stripe is asked", asked.length, 0);
  redis.run(["DEL", placeKey(statsId)]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
