/**
 * The optional rules of a discount code, kept by Stripe (554 [DS1], unit 1;
 * added 1 November 2026). Checked against a stand-in for the creator's
 * Stripe account at the pinned API version:
 *
 *   - a minimum order is written as the promotion code's own restriction
 *     (restrictions[minimum_amount] and restrictions[minimum_amount_currency],
 *     docs.stripe.com/api/promotion_codes/create, read 1 November 2026), in the
 *     store's currency, and nothing else is worked out here;
 *   - a code with no minimum is sent exactly as before, and the coupon is
 *     still "once";
 *   - what Stripe has on a code, made here or in the creator's own dashboard
 *     (a minimum, a first order only, how long on a membership), is read back
 *     and said in plain words, without inventing any of it;
 *   - the studio's confirmation reader takes those fields only when they are
 *     well formed, and an answer without them still reads;
 *   - no product choice and no "first order" is offered for a code made here,
 *     and the editor says why in words;
 *   - the twenty codes and the pinned version are unchanged.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_rules_only";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";

type Sent = { method: string; path: string; body: URLSearchParams; version: string };
const sent: Sent[] = [];
let listed: unknown[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "http://127.0.0.1:4998") throw new Error("Unexpected external provider request");
  const method = init?.method ?? "GET";
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  sent.push({ method, path: url.pathname, body, version: headers["Stripe-Version"] ?? "" });
  const answer = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  if (method === "POST" && url.pathname.endsWith("/coupons")) return answer({ id: "coupon_rules01", duration: body.get("duration") });
  if (method === "POST" && url.pathname.endsWith("/promotion_codes")) {
    const minimum = body.get("restrictions[minimum_amount]");
    return answer({
      id: "promo_rules01",
      code: body.get("code"),
      active: true,
      times_redeemed: 0,
      max_redemptions: null,
      expires_at: null,
      promotion: { type: "coupon", coupon: body.get("promotion[coupon]") },
      restrictions: { first_time_transaction: false, minimum_amount: minimum ? Number(minimum) : null, minimum_amount_currency: body.get("restrictions[minimum_amount_currency]") },
    });
  }
  if (method === "GET" && url.pathname.endsWith("/promotion_codes")) return answer({ data: listed, has_more: false });
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  const { MAX_CODES, codeRules, createCode, listCodes, minimumProblem, CODE_PROBLEMS } = await import("@/lib/discount");
  const { readDiscountConfirmation } = await import("@/lib/discount-confirmation");

  part("A minimum order, written as Stripe's own restriction");
  const made = await createCode("acct_synthetic_rules", "SPRING", { kind: "percent", percent: 20 }, null, { cents: 5000, currency: "usd" });
  const coupon = sent.find((s) => s.path.endsWith("/coupons"))!;
  const promotion = sent.find((s) => s.path.endsWith("/promotion_codes") && s.method === "POST")!;
  is("the coupon is still the first charge only", coupon.body.get("duration"), "once");
  is(
    "the promotion code carries the minimum and its currency",
    [promotion.body.get("restrictions[minimum_amount]"), promotion.body.get("restrictions[minimum_amount_currency]")],
    ["5000", "usd"],
  );
  is("and nothing else is restricted by it: no first order, no products", [...promotion.body.keys()].filter((k) => k.startsWith("restrictions[") || k.includes("applies_to")).sort(), ["restrictions[minimum_amount]", "restrictions[minimum_amount_currency]"]);
  is("both at the pinned version", [coupon.version, promotion.version], ["2025-09-30.clover", "2025-09-30.clover"]);
  is("the code made comes back with its minimum, read from Stripe's answer", made.ok ? [made.code.minimum, made.code.duration, made.code.firstOrder, made.code.otherRules] : null, [{ cents: 5000, currency: "usd" }, { kind: "once" }, false, false]);

  sent.length = 0;
  await createCode("acct_synthetic_rules", "PLAIN", { kind: "amount", cents: 1000, currency: "usd" }, 5);
  const plain = sent.find((s) => s.path.endsWith("/promotion_codes") && s.method === "POST")!;
  is("no minimum: the promotion code is sent exactly as before", [...plain.body.keys()].sort(), ["code", "max_redemptions", "promotion[coupon]", "promotion[type]"]);

  part("What Stripe has on a code, read back and said in words");
  const base = { active: true, times_redeemed: 0, max_redemptions: null, expires_at: null };
  listed = [
    { ...base, id: "promo_a", code: "MIN50", promotion: { coupon: { percent_off: 10, duration: "once" } }, restrictions: { minimum_amount: 5000, minimum_amount_currency: "usd", first_time_transaction: false } },
    { ...base, id: "promo_b", code: "NEWBIE", promotion: { coupon: { amount_off: 500, currency: "eur", duration: "repeating", duration_in_months: 3 } }, restrictions: { first_time_transaction: true, minimum_amount: null, minimum_amount_currency: null } },
    { ...base, id: "promo_c", code: "ALWAYS", promotion: { coupon: { percent_off: 15, duration: "forever" } } },
    { ...base, id: "promo_e", code: "PEREURO", promotion: { coupon: { percent_off: 5, duration: "once" } }, restrictions: { currency_options: { eur: { minimum_amount: 4000 } } } },
    { ...base, id: "promo_d", code: "ODD", promotion: { coupon: { percent_off: 5, duration: "repeating" } }, restrictions: { minimum_amount: -3, minimum_amount_currency: "usd" } },
  ];
  const list = await listCodes("acct_synthetic_rules");
  const codes = list.state === "ok" ? list.codes : [];
  is("read: a minimum, a first order, a few months, every charge, rules this page cannot read", codes.map((c) => [c.minimum, c.firstOrder, c.duration, c.otherRules]), [
    [{ cents: 5000, currency: "usd" }, false, { kind: "once" }, false],
    [null, true, { kind: "repeating", months: 3 }, false],
    [null, false, { kind: "forever" }, false],
    [null, false, { kind: "once" }, true],
    [null, false, null, true],
  ]);
  is("a minimum per currency set in the dashboard is said, not dropped", codeRules(codes[3]), ["It has other rules, set in your Stripe dashboard, that this page cannot show."]);
  is("a minimum in words", codeRules(codes[0]), ["When the first payment is $50 or more."]);
  is(
    "a first order only says how Stripe counts it, and the months on a membership",
    codeRules(codes[1]),
    ["First order only, as Stripe counts it. Checkouts in this store are always new to Stripe, so this rule does not stop a buyer who has bought before.", "On a membership: the first 3 months of charges."],
  );
  is("every charge on a membership", codeRules(codes[2]), ["On a membership: every charge, for as long as it lasts."]);
  is("a minimum that cannot be read is not invented, and not dropped either", codeRules(codes[4]), ["It has other rules, set in your Stripe dashboard, that this page cannot show."]);

  part("The studio's confirmation reads them only when they are well formed");
  const row = { id: "promo_a", code: "MIN50", off: { kind: "percent", percent: 10 }, timesRedeemed: 0, maxRedemptions: null, expiresAt: null, active: true };
  is("an answer from before, without them: still read, with none", readDiscountConfirmation({ ok: true, codes: [row] }, true)?.[0], { ...row, minimum: null, firstOrder: false, duration: null, otherRules: false });
  is(
    "with them: read",
    readDiscountConfirmation({ ok: true, codes: [{ ...row, minimum: { cents: 5000, currency: "USD" }, firstOrder: true, duration: { kind: "repeating", months: 2 } }] }, true)?.[0],
    { ...row, minimum: { cents: 5000, currency: "usd" }, firstOrder: true, duration: { kind: "repeating", months: 2 }, otherRules: false },
  );
  for (const [what, bad] of [
    ["a minimum of nothing", { minimum: { cents: 0, currency: "usd" } }],
    ["a minimum without a currency", { minimum: { cents: 500 } }],
    ["months without a number", { duration: { kind: "repeating" } }],
    ["a duration Stripe does not have", { duration: { kind: "weekly" } }],
    ["a first order that is not yes or no", { firstOrder: "yes" }],
    ["other rules that are not yes or no", { otherRules: 1 }],
  ] as const) {
    is(`${what}: the whole answer is refused`, readDiscountConfirmation({ ok: true, codes: [{ ...row, ...bad }] }, true), null);
  }

  part("Where it is asked and said");
  const route = read("app/api/store/discount/route.ts");
  // Read in lib/discount-input.ts, shared with the API (630 [HN6](19)), in the store's currency.
  const asked = read("lib/discount-input.ts");
  is("the route reads the minimum in the store's currency, within its range, else refuses it", route.includes("readCodeAsked(body, store.currency)") && asked.includes('reason: "minimum"') && /readMoney\(rawMinimum, currency\)/.test(asked) && /priceInRange\(cents, currency\)/.test(asked), true);
  is("and hands it to Stripe with the code", route.includes("createCode(account, code, off, maxRedemptions, minimum)"), true);
  is("a refused minimum is said in words, for every currency", [CODE_PROBLEMS.minimum.length > 20, minimumProblem("eur").includes("EUR"), minimumProblem("jpy").includes("no decimals")], [true, true, true]);
  const editor = read("components/discount-editor.tsx");
  is("the editor's field has a visible label and its help, and is optional", /htmlFor="discount-minimum"/.test(editor) && editor.includes('aria-describedby="discount-minimum-help"') && editor.includes('placeholder="No minimum"') && !/id="discount-minimum"[\s\S]{0,80}required/.test(editor), true);
  is("the help says the minimum is checked on the first payment: a free trial's is zero, a payment plan's is one installment", editor.includes("On a membership with a free trial the first payment is zero, so the code does not come off; on a payment plan it is the first installment."), true);
  is("a minimum in another currency than the store's is warned about", editor.includes("entry.minimum && entry.minimum.currency !== currency"), true);
  is("each code's rules are shown as text under it", editor.includes("codeRules(entry).map((rule) =>"), true);
  is("no product choice is offered, and the editor says why", editor.includes("your products are not saved as products in Stripe") && !editor.includes("applies_to") && !/first_time|firstOrder:/.test(editor), true);
  const lib = read("lib/discount.ts");
  is("nothing here sets a first order or a product limit", /first_time_transaction\]|applies_to\[/.test(lib), false);
  is("twenty codes and the pinned version, unchanged", [MAX_CODES, lib.includes('const API_VERSION = "2025-09-30.clover";')], [20, true]);
  done();
}

void main();
