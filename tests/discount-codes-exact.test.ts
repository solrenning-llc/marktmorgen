/**
 * Board #5285, row #3252: the three LEVEs of review 6897903883 on #3252, still in main.
 *
 * - LEVE 1 (tests): findCode (lib/discount.ts) takes only Stripe's own "no such object" (404 resource_missing) for
 *   "none". A 404 of another kind, a route-level 404, is not known ("error"), never "none".
 * - LEVE 2 (tests): the member offer (app/api/store/member-discount/route.ts) refuses a page of live codes that is
 *   empty but says there are more (has_more true): the live codes are behind it, so it is never "no code to offer".
 * - LEVE 3 (code): codesMayTakeOff, what the codes may take off a checkout for the platform share's fee, read a page
 *   as the whole list unless has_more was exactly true, so a page with no has_more, or one in another shape, was taken
 *   for the whole list. It is read through readStripePage now, as listCodes is: anything but has_more false is
 *   unknown, which sets no fee. It moves no money while COMMISSION_LIVE is false.
 *
 * Healthy controls read as before. A local stand-in for Stripe only: no real account, code or payment.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const BASE = "http://127.0.0.1:4997";
process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_codes_exact_only";
process.env.STRIPE_CONNECT_API_BASE = BASE;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const live = {
  id: "promo_Exact000001", object: "promotion_code", code: "EXACT", active: true, times_redeemed: 0, max_redemptions: null, expires_at: null,
  promotion: { type: "coupon", coupon: { id: "co_exact1", percent_off: 25, duration: "once" } },
};
/** What GET /promotion_codes/:id answers. */
let lookup: () => Response = () => json(live);
/** What GET /promotion_codes (any list) answers. */
let list: () => Response = () => json({ object: "list", data: [live], has_more: false });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.origin !== BASE) throw new Error(`Unexpected external provider request: ${url}`);
  const method = init?.method ?? "GET";
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "GET" && path === "/promotion_codes") return list();
  if (method === "GET" && /^\/promotion_codes\/promo_\w+$/.test(path)) return lookup();
  if (method === "GET" && path === "/customers") return json({ object: "list", has_more: false, data: [{ id: "cus_exact000001" }] });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", has_more: false, data: [] });
  return json({ error: { message: "no stand-in" } }, 404);
}) as typeof fetch;

const ACCOUNT = "acct_1CodesExact0001";

async function main(): Promise<void> {
  // Imported after the stand-in's address is set: lib/stripe-account.ts reads it when loaded.
  const { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription } = await import("@/lib/store");
  const { SESSION_COOKIE, openSession } = await import("@/lib/auth");
  const { codesMayTakeOff, findCode } = await import("@/lib/discount");
  const { POST: memberRoute } = await import("@/app/api/store/member-discount/route");
  const quiet = console.error;
  console.error = () => {};
  try {
    part("LEVE 1: findCode takes only Stripe's own 'no such object' for none");
    lookup = () => json(live);
    is("control: the code is found, live", await findCode(ACCOUNT, live.id), { state: "found", active: true });
    lookup = () => json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such promotion code." } }, 404);
    is("control: Stripe's 404 resource_missing is none", await findCode(ACCOUNT, live.id), { state: "none" });
    for (const [label, body] of [
      ["a 404 with no code", { error: { message: "Unrecognized request URL." } }],
      ["a 404 of another code", { error: { type: "invalid_request_error", code: "url_invalid", message: "Unrecognized request URL." } }],
      ["a 404 with no error at all", {}],
    ] as [string, unknown][]) {
      lookup = () => json(body, 404);
      is(`${label}: not known, never none`, await findCode(ACCOUNT, live.id), { state: "error" });
    }
    // The LEVE's second half (Claude 2 lpgvy on #5337): an `active` in another shape is not known either, never a
    // live or a stopped code.
    for (const [label, active] of [["active as a word", "true"], ["active null", null], ["active as a number", 1]] as [string, unknown][]) {
      lookup = () => json({ ...live, active });
      is(`${label}: not known, never a code found`, await findCode(ACCOUNT, live.id), { state: "error" });
    }
    lookup = () => json((({ active: _active, ...rest }) => rest)(live));
    is("no active at all: not known", await findCode(ACCOUNT, live.id), { state: "error" });
    lookup = () => json({ ...live, active: false });
    is("control: a stopped code is found, not live", await findCode(ACCOUNT, live.id), { state: "found", active: false });
    lookup = () => json(live);

    part("LEVE 2: the member offer refuses an empty page of live codes that says there are more");
    redis.clear();
    const OWNER = "codesexact@example.com";
    await claimHandle(OWNER, "codesexact", "Codes Exact", "Synthetic.");
    await ensureStatsId(OWNER);
    await ensureStoreId(OWNER);
    await setStripeAccount(OWNER, ACCOUNT, true);
    await setSubscription(OWNER, { customerId: "cus_codesexact", subscriptionId: "sub_codesexact", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const session = await openSession(OWNER);
    const find = async () => {
      const r = await memberRoute(new NextRequest("https://marktmorgen.com/api/store/member-discount", {
        method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "find", email: "member@example.com" }),
      }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    list = () => json({ object: "list", data: [live], has_more: false });
    const whole = await find();
    is("control: a whole page offers its live code", [whole.status, whole.body.codes], [200, [{ id: live.id, code: "EXACT" }]]);
    list = () => json({ object: "list", data: [], has_more: false });
    const none = await find();
    is("control: an empty last page is 'no live code'", [none.status, none.body.codes], [200, []]);
    list = () => json({ object: "list", data: [], has_more: true });
    const cut = await find();
    is("an empty page that says there are more: Stripe could not be read (502), never 'no code to offer'", [cut.status, cut.body.error], [502, "stripe"]);

    part("LEVE 3: codesMayTakeOff reads the page exactly; anything but has_more false is unknown");
    list = () => json({ object: "list", data: [live], has_more: false });
    is("control: a whole page says what may come off", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "percent", percent: 25 }]);
    list = () => json({ object: "list", data: [], has_more: false });
    is("control: no live code, said so whole: nothing comes off", await codesMayTakeOff(ACCOUNT, "usd"), []);
    for (const [label, page] of [
      ["a page with no has_more", { object: "list", data: [live] }],
      ["has_more as a word", { object: "list", data: [live], has_more: "false" }],
      ["has_more null", { object: "list", data: [], has_more: null }],
      ["more than the page", { object: "list", data: [live], has_more: true }],
      ["a row with no id", { object: "list", data: [{ ...live, id: undefined }], has_more: false }],
    ] as [string, unknown][]) {
      list = () => json(page);
      is(`${label}: unknown, never the whole list`, await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    }
  } finally {
    console.error = quiet;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
