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
 *
 * A make or a stop that Stripe already did is never answered as a failure
 * because only the list after it could not be confirmed: a creator told
 * "error" after a code was really made may press again. The studio and the
 * API say it was done and that the codes could not be read back, and write
 * nothing to hasDiscounts from that list.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const BASE = "http://127.0.0.1:4997";
process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_list_complete_only";
process.env.STRIPE_CONNECT_API_BASE = BASE;

let page: unknown = null;
/** Pages answered first, one per list, before `page` (the code found before a stop, then the list after it). */
const pages: unknown[] = [];
const asked: string[] = [];
const writes: string[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== BASE) throw new Error(`Unexpected external provider request: ${url}`);
  const method = init?.method ?? "GET";
  const form = new URLSearchParams(init?.body ? String(init.body) : "");
  if (method === "GET" && url.pathname.endsWith("/promotion_codes")) {
    asked.push(url.pathname + url.search);
    return json(pages.length ? pages.shift() : page);
  }
  if (method === "POST" && url.pathname.endsWith("/coupons")) {
    writes.push("coupon");
    return json({ id: "coupon_ListComplete1", object: "coupon", duration: "once", percent_off: Number(form.get("percent_off")) });
  }
  if (method === "POST" && url.pathname.endsWith("/promotion_codes")) {
    writes.push("promotion");
    return json({ ...row(90, true), id: "promo_ListMade000001", code: form.get("code") });
  }
  const stop = url.pathname.match(/\/promotion_codes\/(promo_\w+)$/);
  if (method === "POST" && stop && form.get("active") === "false") {
    writes.push(`stop ${stop[1]}`);
    return json({ ...row(1, false), id: stop[1] });
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
  const { DELETE: apiStop } = await import("@/app/api/v1/codes/route");
  const { makeKey } = await import("@/lib/api-keys");
  const { readDiscountConfirmation } = await import("@/lib/discount-confirmation");
  const stopped = Array.from({ length: MAX_CODES }, (_, i) => row(i, false));
  redis.clear();
  const OWNER = "listcomplete@example.com";
  await claimHandle(OWNER, "listcomplete", "List Complete", "Synthetic.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_listcomplete", subscriptionId: "sub_listcomplete", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const studio = (body: Record<string, unknown>) =>
    discountRoute(new NextRequest("https://marktmorgen.com/api/store/discount", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const listRoute = () => studio({ action: "list" });
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

  part("A code made on Stripe, the codes then not confirmed: the make is said as done, never as a failure");
  await setHasDiscounts(OWNER, false);
  page = { object: "list", data: stopped, has_more: true, url: "/v1/promotion_codes" };
  writes.length = 0;
  const made = await studio({ action: "add", code: "LISTDONE", kind: "percent", percent: "15" });
  const madeBody = (await made.json()) as Record<string, unknown>;
  is("Stripe made one coupon and one code", writes, ["coupon", "promotion"]);
  is("the route answers that the code was made, the list not confirmed (not 502, so it is not pressed again)", [made.status, madeBody], [200, { ok: true, done: "add", listed: false }]);
  is("the code just made is live, so the add's own write stands; nothing is written from the unconfirmed list", await flag(), true);
  is("the studio never reads that answer as a list (it shows its 'could not confirm' words)", readDiscountConfirmation(madeBody, made.ok), null);

  part("A code switched off on Stripe, the codes then not confirmed: the stop is said as done");
  await setHasDiscounts(OWNER, true);
  page = { object: "list", data: [], has_more: true, url: "/v1/promotion_codes" };
  writes.length = 0;
  const off = await studio({ action: "stop", id: "promo_List000001" });
  const offBody = (await off.json()) as Record<string, unknown>;
  is("Stripe switched the one code off", writes, ["stop promo_List000001"]);
  is("the route answers that it was switched off, the list not confirmed", [off.status, offBody], [200, { ok: true, done: "stop", listed: false }]);
  is("and hasDiscounts is not written false from the unconfirmed list", await flag(), true);
  is("the studio never reads it as a list", readDiscountConfirmation(offBody, off.ok), null);
  is("the studio's words for it already exist", readFileSync("components/discount-editor.tsx", "utf8").includes("We could not confirm the discount codes. Reload to check their status before trying again."), true);

  part("The API: a code switched off, the codes then not confirmed");
  const API_OWNER = "listcompleteapi@example.com";
  const API_ACCOUNT = "acct_1ListDoneApi";
  await claimHandle(API_OWNER, "listcompleteapi", "List Complete API", "Synthetic.");
  await ensureStatsId(API_OWNER);
  await setStripeAccount(API_OWNER, API_ACCOUNT, true);
  await setSubscription(API_OWNER, { customerId: "cus_listcompleteapi", subscriptionId: "sub_listcompleteapi", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setHasDiscounts(API_OWNER, true);
  const apiStore = (await storeForEmail(API_OWNER))!;
  const key = await makeKey(apiStore.sid, "Synthetic writer", Date.now(), true);
  if (!key.ok) throw new Error("no synthetic key");
  const apiDelete = async (id: string) => {
    const r = await apiStop(new Request(`https://marktmorgen.com/api/v1/codes?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  pages.length = 0;
  pages.push({ object: "list", data: [row(1, true)], has_more: false, url: "/v1/promotion_codes" });
  page = { object: "list", data: [], has_more: true, url: "/v1/promotion_codes" };
  writes.length = 0;
  const apiOff = await apiDelete("promo_List000001");
  is("Stripe switched the one code off", writes, ["stop promo_List000001"]);
  is("the API answers 200 with the code switched off and the codes not confirmed", [apiOff.status, apiOff.body.stopped, apiOff.body.listed, typeof apiOff.body.message], [200, "promo_List000001", false, "string"]);
  is("and hasDiscounts is not written false from the unconfirmed list", (await storeForEmail(API_OWNER))?.hasDiscounts, true);
  pages.length = 0;
  page = { object: "list", data: [row(1, true)], has_more: true, url: "/v1/promotion_codes" };
  writes.length = 0;
  const notFound = await apiDelete("promo_List000001");
  is("the code to stop is looked for only in a confirmed list: refused, nothing sent", [notFound.status, writes], [502, []]);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
