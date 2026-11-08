/**
 * Rule 24 (CX-123), second half: a store with more discount codes than one
 * page of Stripe's /promotion_codes (MAX_CODES) keeps every way of using
 * them. Stripe never deletes a promotion code, so from the 21st code made on
 * an account the list always has a next page; refusing every list with
 * `has_more: true` would take the studio list, GET and DELETE
 * /api/v1/codes, the member discount and the affiliate codes from that store
 * for good (Claude 2's first money review of #3252).
 *
 * What a page proves, and only that (lib/stripe-list.ts):
 *   - a code found is found, on any page: a lookup asks Stripe for that one
 *     code (GET /promotion_codes/:id), so a code on page 2 is found too;
 *   - "none" only from a list read to its end (has_more false): with a page
 *     behind it, no live code on the newest page is not "no live code", so
 *     hasDiscounts is written false only from a complete list, and the
 *     studio and the API say the list is the newest page, not everything;
 *   - a lookup Stripe cannot answer, or answers with another code, is not
 *     "no such code": refused, nothing switched off or put on a membership.
 *
 * Still one Stripe request for a list and at most three for a stop, so the
 * API's published counts (lib/api-read-rules.ts, codesWork, codeStopWork)
 * do not move. A synthetic Stripe stand-in with real pagination; nothing
 * leaves this machine.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const BASE = "http://127.0.0.1:4996";
process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_list_pages_only";
process.env.STRIPE_CONNECT_API_BASE = BASE;

type Row = Record<string, unknown> & { id: string; active: boolean };
/** Every code on the stand-in account, newest first, as Stripe lists them. */
let codes: Row[] = [];
/** What the next lookup of one code answers instead of the code. */
let lookup: "real" | "fail" | "other" = "real";
/** Lists answered with an error once this many have been answered (Infinity: never). */
let listsBeforeFailing = Infinity;
const asked: string[] = [];
const writes: string[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const missing = () => json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such promotion code." } }, 404);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== BASE) throw new Error(`Unexpected external provider request: ${url}`);
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  const form = new URLSearchParams(init?.body ? String(init.body) : "");
  asked.push(`${method} ${path}${url.search}`);
  if (method === "GET" && path === "/promotion_codes") {
    if (listsBeforeFailing <= 0) return json({ error: { message: "Synthetic list failure" } }, 500);
    listsBeforeFailing -= 1;
    let rows = codes;
    if (url.searchParams.get("active") === "true") rows = rows.filter((r) => r.active);
    if (url.searchParams.get("active") === "false") rows = rows.filter((r) => !r.active);
    const after = url.searchParams.get("starting_after");
    if (after) rows = rows.slice(rows.findIndex((r) => r.id === after) + 1);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return json({ object: "list", url: "/v1/promotion_codes", data: rows.slice(0, limit), has_more: rows.length > limit });
  }
  const one = path.match(/^\/promotion_codes\/(promo_\w+)$/);
  if (method === "GET" && one) {
    if (lookup === "fail") return json({ error: { message: "Synthetic lookup failure" } }, 500);
    const row = codes.find((r) => r.id === one[1]);
    if (lookup === "other") return json({ ...codes[0], id: "promo_SomeoneElse01" });
    return row ? json(row) : missing();
  }
  if (method === "POST" && one && form.get("active") === "false") {
    const row = codes.find((r) => r.id === one[1]);
    if (!row) return missing();
    writes.push(`stop ${one[1]}`);
    row.active = false;
    return json(row);
  }
  if (method === "GET" && path === "/customers") {
    return json({ object: "list", has_more: false, data: url.searchParams.get("email") === "member@example.com" ? [{ id: "cus_pages000001" }] : [] });
  }
  if (method === "GET" && path === "/subscriptions") {
    const sub = { id: "sub_pages000001", status: "active", metadata: { store: "listpages", product: "prod000001" }, items: { data: [{ price: { unit_amount: 2900, currency: "usd", recurring: { interval: "month" } } }] } };
    return json({ object: "list", has_more: false, data: url.searchParams.get("customer") === "cus_pages000001" ? [sub] : [] });
  }
  if (method === "POST" && path.startsWith("/subscriptions/")) {
    writes.push(`discount ${path.split("/")[2]} ${form.get("discounts[0][promotion_code]")}`);
    return json({ id: path.split("/")[2] });
  }
  return json({ error: { message: "no stand-in" } }, 404);
}) as typeof fetch;

const row = (i: number, active: boolean): Row => ({
  id: `promo_Page${String(i).padStart(6, "0")}`,
  object: "promotion_code",
  code: `PAGE${i}`,
  active,
  times_redeemed: 0,
  max_redemptions: null,
  expires_at: null,
  promotion: { type: "coupon", coupon: { id: `co_${i}`, percent_off: 10, duration: "once" } },
});
/** Newest first: index 0 is the code made last. */
const account = (live: (i: number) => boolean, count = 21) => Array.from({ length: count }, (_, i) => row(count - i, live(count - i)));
const ACCOUNT = "acct_1ListPages0001";

async function main(): Promise<void> {
  // Imported after the stand-in's address is set: lib/stripe-account.ts reads it when loaded.
  const { claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
  const { SESSION_COOKIE, openSession } = await import("@/lib/auth");
  const discount = await import("@/lib/discount");
  const { MAX_CODES, listCodes } = discount;
  const { POST: studioRoute } = await import("@/app/api/store/discount/route");
  const { POST: memberRoute } = await import("@/app/api/store/member-discount/route");
  const { GET: apiList, DELETE: apiStop } = await import("@/app/api/v1/codes/route");
  const { applyMemberDiscount } = await import("@/lib/member-discount");
  const { makeKey } = await import("@/lib/api-keys");
  const confirmation = (await import("@/lib/discount-confirmation")) as Record<string, unknown>;

  redis.clear();
  const OWNER = "listpages@example.com";
  await claimHandle(OWNER, "listpages", "List Pages", "Synthetic.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_listpages", subscriptionId: "sub_listpages", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const session = await openSession(OWNER);
  const post = (route: (r: NextRequest) => Promise<Response>, url: string, body: Record<string, unknown>) =>
    route(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const studio = async (body: Record<string, unknown>) => {
    const r = await post(studioRoute, "https://marktmorgen.com/api/store/discount", body);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const member = async (body: Record<string, unknown>) => {
    const r = await post(memberRoute, "https://marktmorgen.com/api/store/member-discount", body);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const store = async () => (await storeForEmail(OWNER))!;
  const flag = async () => (await store()).hasDiscounts;
  const key = await makeKey((await store()).sid, "Synthetic writer", Date.now(), true);
  if (!key.ok) throw new Error("no synthetic key");
  const api = async (method: "GET" | "DELETE", query = "") => {
    const request = new Request(`https://marktmorgen.com/api/v1/codes${query}`, { method, headers: { Authorization: `Bearer ${key.key}` } });
    const r = await (method === "GET" ? apiList(request) : apiStop(request));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const ids = (list: unknown) => (Array.isArray(list) ? list.map((c) => (c as { id: string }).id) : list);
  const reset = (next: Row[]) => {
    codes = next;
    lookup = "real";
    listsBeforeFailing = Infinity;
    asked.length = 0;
    writes.length = 0;
  };

  part("21 codes, the newest live and twenty older ones switched off (Claude 2's case): every way still works");
  reset(account((i) => i === 21));
  const newest = codes[0].id;
  const first = await listCodes(ACCOUNT);
  is("the newest page is read, said to be the newest page and not everything", first.state === "ok" ? [first.codes.length, first.codes[0].id, (first as { complete?: unknown }).complete] : first, [MAX_CODES, newest, false]);
  await setHasDiscounts(OWNER, false);
  const listed = await studio({ action: "list" });
  is("the studio lists the newest page and says there are more", [listed.status, listed.body.ok, ids(listed.body.codes)?.length, listed.body.complete], [200, true, MAX_CODES, false]);
  is("a live code found on it is enough for the checkout's box", await flag(), true);
  asked.length = 0;
  const read = await api("GET");
  is("GET /api/v1/codes answers the newest page, with has_more", [read.status, ids(read.body.data)?.length, read.body.has_more], [200, MAX_CODES, true]);
  is("still exactly one Stripe request, no second page (codesWork stripePages 1)", [asked.length, asked.some((a) => a.includes("starting_after"))], [1, false]);
  await setHasDiscounts(OWNER, true);
  asked.length = 0;
  const stopped = await api("DELETE", `?id=${newest}`);
  is("DELETE switches the live code off", [stopped.status, writes], [200, [`stop ${newest}`]]);
  is("and answers the newest page as Stripe says now, with has_more", [ids(stopped.body.data)?.length, stopped.body.has_more], [MAX_CODES, true]);
  is("at most three Stripe requests (codeStopWork stripePages 3), no second page", [asked.length <= 3, asked.some((a) => a.includes("starting_after"))], [true, false]);
  is("no live code on the newest page is not 'none' while a page is behind it: hasDiscounts not written false", await flag(), true);

  part("The code looked for is on page 2: found, as Stripe finds it");
  reset(account((i) => i === 1));
  const older = codes[20].id;
  await setHasDiscounts(OWNER, true);
  const page = await studio({ action: "list" });
  is("the studio lists the newest page, all switched off, and says there are more", [page.status, ids(page.body.codes)?.length, page.body.complete], [200, MAX_CODES, false]);
  is("hasDiscounts is not written false from it", await flag(), true);
  const live = await listCodes(ACCOUNT, { active: true } as never);
  is("the live codes alone are one page, read to its end", live.state === "ok" ? [ids(live.codes), (live as { complete?: unknown }).complete] : live, [[older], true]);
  const found = await member({ action: "find", email: "member@example.com" });
  is("the member discount offers the older live code", [found.status, found.body.codes], [200, [{ id: older, code: "PAGE1" }]]);
  writes.length = 0;
  is("and puts it on the membership", await applyMemberDiscount(await store(), "member@example.com", "sub_pages000001", older), { ok: true });
  is("one discount sent to Stripe, for that code", writes, [`discount sub_pages000001 ${older}`]);
  writes.length = 0;
  const off = await api("DELETE", `?id=${older}`);
  is("DELETE finds the older live code and switches it off", [off.status, writes], [200, [`stop ${older}`]]);

  part("A lookup Stripe cannot answer is not 'no such code'");
  reset(account((i) => i === 1));
  is("Stripe says the code does not exist: 404, nothing switched off", [(await api("DELETE", "?id=promo_NotHere00001")).status, writes], [404, []]);
  lookup = "fail";
  is("the lookup fails: 502, nothing switched off", [(await api("DELETE", `?id=${codes[20].id}`)).status, writes], [502, []]);
  is("the lookup fails: the member discount says Stripe, nothing put on", [await applyMemberDiscount(await store(), "member@example.com", "sub_pages000001", codes[20].id), writes], [{ ok: false, reason: "stripe" }, []]);
  lookup = "other";
  is("the lookup answers another code: 502, nothing switched off", [(await api("DELETE", `?id=${codes[20].id}`)).status, writes], [502, []]);
  is("the lookup answers another code: the member discount says Stripe, nothing put on", [await applyMemberDiscount(await store(), "member@example.com", "sub_pages000001", codes[20].id), writes], [{ ok: false, reason: "stripe" }, []]);
  lookup = "real";
  is("a switched-off code is refused as not active", await applyMemberDiscount(await store(), "member@example.com", "sub_pages000001", codes[0].id), { ok: false, reason: "code" });
  is("a code Stripe does not have is refused as not active", await applyMemberDiscount(await store(), "member@example.com", "sub_pages000001", "promo_NotHere00001"), { ok: false, reason: "code" });
  is("nothing was put on a membership", writes, []);

  part("Controls: a list read to its end is the whole list, as before");
  reset(account(() => false, 3));
  await setHasDiscounts(OWNER, true);
  const whole = await studio({ action: "list" });
  is("the studio says the list is complete", [whole.status, ids(whole.body.codes)?.length, whole.body.complete], [200, 3, true]);
  is("with no live code in a complete list, hasDiscounts is written false", await flag(), false);
  const all = await api("GET");
  is("GET says has_more false", [all.status, ids(all.body.data)?.length, all.body.has_more], [200, 3, false]);
  reset([row(2, true), row(1, false)]);
  const one = await api("DELETE", `?id=${codes[0].id}`);
  is("DELETE of the last live code in a complete list: switched off, hasDiscounts false", [one.status, one.body.has_more, await flag()], [200, false, false]);

  part("A stop done, the list after it not read: said as done, the list as unknown (null), never as empty");
  reset([row(2, true), row(1, false)]);
  await setHasDiscounts(OWNER, true);
  listsBeforeFailing = 0;
  const unread = await api("DELETE", `?id=${codes[0].id}`);
  is("200 with the stop, listed false and data null", [unread.status, unread.body.stopped, unread.body.listed, unread.body.data, typeof unread.body.message], [200, codes[0].id, false, null, "string"]);
  is("nothing written from the list not read", await flag(), true);

  part("Said to the creator and to developers");
  const complete = confirmation.discountListComplete as ((raw: unknown) => boolean) | undefined;
  is("the studio reads 'complete' only from an exact true", typeof complete === "function" ? [complete({ ok: true, codes: [], complete: true }), complete({ ok: true, codes: [], complete: false }), complete({ ok: true, codes: [] }), complete({ ok: true, codes: [], complete: "true" })] : "missing", [true, false, false, false]);
  const editor = readFileSync("components/discount-editor.tsx", "utf8");
  is("the editor says when it shows only the newest codes", editor.includes(`These are your ${MAX_CODES} newest codes.`) || editor.includes("These are your {MAX_CODES} newest codes.") || editor.includes("These are your ${MAX_CODES} newest codes."), true);
  const developers = readFileSync("app/developers/page.tsx", "utf8");
  is("the developers page documents has_more", developers.includes("has_more"), true);
  is("and the stop whose list could not be read back", developers.includes("listed: false"), true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
