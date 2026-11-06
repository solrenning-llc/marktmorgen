/**
 * Rule 24 (CX-123): the creator's discount codes are read as one page of
 * Stripe's /promotion_codes (limit MAX_CODES, newest first, stopped codes
 * included), and that page is taken as the whole list only when Stripe says
 * so: `has_more` exactly false (docs.stripe.com/api/pagination). Synthetic
 * Stripe stand-in only; no real account is asked.
 *
 * Why it matters: app/api/store/discount/route.ts writes the store's
 * hasDiscounts from the list (any active code), and that bit decides whether
 * every checkout offers the code box (allow_promotion_codes) and whether the
 * affiliate pages stay open. A page Stripe says is not the last one (twenty
 * newer stopped codes, an older live one behind them), or a page that does
 * not say, is not proof that no live code exists: listCodes refuses it, the
 * route answers 502 and writes nothing. Exactly one page is still asked, so
 * the read's cost (lib/api-read-rules.ts, stripePages 1) is unchanged.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const BASE = "http://127.0.0.1:4997";
process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_list_complete_only";
process.env.STRIPE_CONNECT_API_BASE = BASE;

let page: unknown = null;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== BASE) throw new Error(`Unexpected external provider request: ${url}`);
  if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/promotion_codes")) {
    asked.push(url.pathname + url.search);
    return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

const row = (i: number, active: boolean) => ({
  id: `promo_List${String(i).padStart(6, "0")}`,
  object: "promotion_code",
  code: `CODE${i}`,
  active,
  times_redeemed: 0,
  max_redemptions: null,
  expires_at: null,
  promotion: { coupon: { percent_off: 10 } },
});
const ACCOUNT = "acct_1ListComplete01";

async function main(): Promise<void> {
  // Imported after the stand-in's address is set: lib/stripe-account.ts reads it when loaded.
  const { claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
  const { SESSION_COOKIE, openSession } = await import("@/lib/auth");
  const { MAX_CODES, listCodes } = await import("@/lib/discount");
  const { POST: discountRoute } = await import("@/app/api/store/discount/route");
  const stopped = Array.from({ length: MAX_CODES }, (_, i) => row(i, false));
  redis.clear();
  const OWNER = "listcomplete@example.com";
  await claimHandle(OWNER, "listcomplete", "List Complete", "Synthetic.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_listcomplete", subscriptionId: "sub_listcomplete", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const listRoute = () =>
    discountRoute(new NextRequest("https://marktmorgen.com/api/store/discount", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "list" }) }));
  const flag = async () => (await storeForEmail(OWNER))?.hasDiscounts;

  part("A page Stripe says is not the last one is not the whole list");
  await setHasDiscounts(OWNER, true);
  page = { object: "list", data: stopped, has_more: true, url: "/v1/promotion_codes" };
  asked.length = 0;
  is("twenty newer stopped codes, an older one on the next page: refused, not 'ok'", await listCodes(ACCOUNT), { state: "error" });
  is("one page asked, at the same limit, no second page (cost unchanged)", [asked.length, asked[0]?.includes(`limit=${MAX_CODES}`), asked.some((a) => a.includes("starting_after"))], [1, true, false]);
  const partial = await listRoute();
  is("the route answers that Stripe could not be read", [partial.status, await partial.json()], [502, { ok: false, error: "stripe" }]);
  is("and hasDiscounts is not written false while a live code may exist", await flag(), true);

  part("A page that does not say whether it is the last is not the whole list");
  for (const [what, more] of [
    ["has_more missing", undefined],
    ["has_more null", null],
    ["has_more as the text \"false\"", "false"],
    ["has_more as 0", 0],
  ] as const) {
    await setHasDiscounts(OWNER, true);
    page = more === undefined ? { object: "list", data: [] } : { object: "list", data: [], has_more: more };
    is(`${what}: refused, not an empty list`, await listCodes(ACCOUNT), { state: "error" });
    const answer = await listRoute();
    is(`${what}: the route answers 502`, answer.status, 502);
    is(`${what}: hasDiscounts left as it was`, await flag(), true);
  }

  part("Controls: a page Stripe says is the last one is read as before");
  await setHasDiscounts(OWNER, true);
  page = { object: "list", data: [], has_more: false, url: "/v1/promotion_codes" };
  is("a confirmed empty list is still an empty list", await listCodes(ACCOUNT), { state: "ok", codes: [] });
  const empty = await listRoute();
  is("the route answers it", [empty.status, ((await empty.json()) as { codes?: unknown }).codes], [200, []]);
  is("and with no code at all, hasDiscounts is written false", await flag(), false);

  page = { object: "list", data: stopped, has_more: false, url: "/v1/promotion_codes" };
  const all = await listCodes(ACCOUNT);
  is("twenty stopped codes, confirmed the whole list: read, all off", all.state === "ok" ? [all.codes.length, all.codes.some((c) => c.active)] : all, [MAX_CODES, false]);

  page = { object: "list", data: [row(1, true), row(2, false)], has_more: false, url: "/v1/promotion_codes" };
  const live = await listRoute();
  is("a live code on the last page: the route answers it", live.status, 200);
  is("and hasDiscounts is written true", await flag(), true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
