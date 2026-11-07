/**
 * A Stripe list page read in its exact shape (CX-123 rule 24, rule 30; found by
 * Claude 5 in review 6704697572 on #3048). A page whose `data` is not a list,
 * whose `has_more` is not true or false, or that says there is more but has no
 * last id to go on from, is a reading not made: it fails closed, never reads
 * as an empty or complete list. Checked, with a stand-in for Stripe:
 *
 *   - whether a buyer is new or returning (lib/ad-events.ts, customerType),
 *     which says null when unknown;
 *   - the renewals sent to the ad platforms (lib/ad-events.ts, sendRenewals),
 *     reading every page of the day's paid invoices.
 *
 * Whether a moved member already kept a membership (lib/move-members.ts,
 * keptAlready) is read in its exact shape by #2685, not here.
 */
import { adsCheckout, customerType, sendRenewals, setServerToken } from "@/lib/ad-events";
import { nextAdsCookie, adsCookieName } from "@/lib/ad-consent";
import { NO_PIXELS } from "@/lib/pixels";
import { claimHandle, ensureStatsId, setAdsServer, setPixels, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_stripe_pages_stand_in";

const OWNER = "pages-owner@example.com";
const ACCOUNT = "acct_1TestPages01";
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000);

/** Each Stripe list path answers with the next page from its queue, or an empty, whole list. */
const pages = new Map<string, unknown[]>();
const asked: string[] = [];
const sentTo: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (["graph.facebook.com", "business-api.tiktok.com", "www.google-analytics.com", "api.pinterest.com"].includes(url.hostname)) {
    sentTo.push(String(JSON.parse(String(init?.body ?? "{}"))?.data?.[0]?.event_id ?? ""));
    return json({ events_received: 1 });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  asked.push(path + url.search);
  const queue = pages.get(path);
  const next = queue && queue.length ? queue.shift() : { object: "list", data: [], has_more: false };
  return json(next);
}) as typeof fetch;

/** Whether the call threw, or what it answered. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pages", "Pages Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  let store = (await storeForEmail(OWNER))!;

  part("Whether a buyer is new or returning (customerType)");
  const session = (id: string, created: number) => ({ id, payment_status: "paid", created });
  pages.set("/checkout/sessions", [{ object: "list", data: [session("cs_test_now", SEC)], has_more: false }]);
  is("control: only this checkout, new", await customerType(store, "b@example.com", "cs_test_now", SEC), "new");
  pages.set("/checkout/sessions", [{ object: "list", data: [session("cs_test_now", SEC), session("cs_test_old", SEC - 999)], has_more: false }]);
  is("control: an earlier paid checkout, returning", await customerType(store, "b@example.com", "cs_test_now", SEC), "returning");
  pages.set("/checkout/sessions", [{ object: "list", data: { id: "cs_test_old" }, has_more: false }]);
  is("a page whose data is not a list is unknown (null), never new", await customerType(store, "b@example.com", "cs_test_now", SEC), null);
  pages.set("/checkout/sessions", [{ object: "list", data: [session("cs_test_now", SEC)] }]);
  is("a page with no has_more is unknown (null)", await customerType(store, "b@example.com", "cs_test_now", SEC), null);
  pages.set("/checkout/sessions", [{ object: "list", data: [session("cs_test_now", SEC)], has_more: true }]);
  is("more checkouts than one page with none earlier on it is unknown (null), never new", await customerType(store, "b@example.com", "cs_test_now", SEC), null);

  part("Renewals sent to the ad platforms (sendRenewals)");
  await setPixels(OWNER, { ...NO_PIXELS, meta: "123456789012345" });
  await setServerToken(store.statsId!, "meta", "EAAB" + "m".repeat(60));
  await setAdsServer(OWNER, ["meta"]);
  store = (await storeForEmail(OWNER))!;
  const request = {
    headers: new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "UA", referer: "https://marktmorgen.com/@pages/p/club" }),
    cookies: { get: (name: string) => (name === adsCookieName("pages") ? { value: nextAdsCookie(undefined, "?fbclid=IwAR0abc", SEC - 3600) } : name === "_fbp" ? { value: "fb.1.1.1" } : undefined) },
  };
  const ads = (await adsCheckout(request, store, NOW)).ads as string;
  for (const id of ["sub_Renew0001", "sub_Renew0002"]) redis.run(["SET", `nl:adsrv:sub:${id}`, JSON.stringify({ _fbp: "fb.1.1.1" })]);
  const invoice = (id: string, subId: string) => ({
    id,
    status: "paid",
    billing_reason: "subscription_cycle",
    amount_paid: 4900,
    currency: "usd",
    created: SEC - 300,
    parent: { subscription_details: { subscription: subId, metadata: { store: "pages", product: "club000001", ads } } },
  });
  pages.set("/invoices", [{ object: "list", data: [invoice("in_Renew0001", "sub_Renew0001")], has_more: false }]);
  is("control: one whole page sends its renewal", await sendRenewals(store, NOW), 1);
  pages.set("/invoices", [
    { object: "list", data: [invoice("in_Renew0001", "sub_Renew0001")], has_more: true },
    { object: "list", data: [invoice("in_Renew0002", "sub_Renew0002")], has_more: false },
  ]);
  asked.length = 0;
  is("a renewal on the second page is read and sent, never left as if the list had ended", await sendRenewals(store, NOW), 1);
  is("the second page asked after the first one's last invoice", asked.some((a) => a.startsWith("/invoices") && a.includes("starting_after=in_Renew0001")), true);
  pages.set("/invoices", [{ object: "list", data: "none", has_more: false }]);
  is("a page whose data is not a list fails, never 'no renewals'", await outcome(() => sendRenewals(store, NOW)), "threw");
  pages.set("/invoices", [{ object: "list", data: [] }]);
  is("a page with no has_more fails", await outcome(() => sendRenewals(store, NOW)), "threw");
  pages.set("/invoices", [{ object: "list", data: [], has_more: true }]);
  is("a page that says more with no last one fails", await outcome(() => sendRenewals(store, NOW)), "threw");
  pages.set("/invoices", Array.from({ length: 10 }, (_, i) => ({ object: "list", data: [{ ...invoice(`in_RenewCap${i}`, "sub_None"), billing_reason: "manual" }], has_more: true })));
  is("more pages than the cap fails, never 'no renewals'", await outcome(() => sendRenewals(store, NOW)), "threw");
  is("nothing sent to the platforms for a page that was not read", sentTo.filter((id) => id.startsWith("in_RenewCap")), []);
  // A pass whose deadline has gone asks no page after the first (Claude 2, review 6707563715 on #3054):
  // it fails as a page not read does, and the sweep tries again next pass.
  pages.set("/invoices", [
    { object: "list", data: [invoice("in_RenewLate1", "sub_Renew0001")], has_more: true },
    { object: "list", data: [invoice("in_RenewLate2", "sub_Renew0002")], has_more: true },
    { object: "list", data: [invoice("in_RenewLate3", "sub_Renew0002")], has_more: false },
  ]);
  asked.length = 0;
  sentTo.length = 0;
  is("past the pass's deadline, more pages than one fails, never 'no renewals'", await outcome(() => sendRenewals(store, NOW, Date.now() - 1)), "threw");
  is("past the pass's deadline, no page after the first is asked", asked.filter((a) => a.startsWith("/invoices")).length, 1);
  is("past the pass's deadline, nothing is sent", sentTo.filter((id) => id.startsWith("in_RenewLate")), []);
  pages.delete("/invoices");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
