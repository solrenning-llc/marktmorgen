/**
 * #4699 (Codex X8): a code typed on a booking with a deposit is applied by the app itself, outside Stripe's checkout,
 * so every rule of the code must be read before the price is cut. Absent restrictions, a limit or an end date that is
 * not a number, and a page of one row with more rows after it were read as "no rule". Each is now a refusal.
 * Synthetic Stripe stand-in; no real account.
 */
import { depositWithCode, readDepositCode } from "@/lib/deposit-code";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_deposit_code_unread";
const NOW = 1_800_000_000;
const coupon = { id: "c1", percent_off: 25, amount_off: null, currency: null, valid: true, max_redemptions: null, redeem_by: null, applies_to: null };
const row = (over: Record<string, unknown> = {}, couponOver: Record<string, unknown> = {}) => ({
  id: "promo_1",
  code: "SPRING",
  active: true,
  expires_at: null,
  max_redemptions: null,
  restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null },
  promotion: { type: "coupon", coupon: { ...coupon, ...couponOver } },
  ...over,
});
let page: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/v1/promotion_codes") return Response.json(page);
  return Response.json({ error: { message: "unexpected" } }, { status: 404 });
}) as typeof fetch;

const booking = { priceCents: 10000, deposit: 2500, currency: "usd" as const, nowSeconds: NOW };
async function outcome(data: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<string> {
  page = { object: "list", has_more: false, data, ...extra };
  const code = await readDepositCode("acct_1DepCodeUnread01", "SPRING");
  if (!code) return "refused: no code";
  const result = depositWithCode(code, booking);
  return result.ok ? `applied: charged ${result.figures.charged}, rest ${result.figures.rest}` : `refused: ${result.why}`;
}

async function main(): Promise<void> {
  part("A $100 booking, a $25 deposit, a 25% code");
  is("(control) a code proven unrestricted is applied", await outcome([row()]), "applied: charged 2500, rest 5000");
  is("(control) a real end date still in the future is applied", await outcome([row({ expires_at: NOW + 3600 })]), "applied: charged 2500, rest 5000");
  const { restrictions: _gone, ...noRestrictions } = row();
  const cases: [string, Record<string, unknown>[], Record<string, unknown>?][] = [
    ["restrictions absent", [noRestrictions]],
    ["restrictions not an object", [row({ restrictions: "none" })]],
    ["first order rule not a yes or no", [row({ restrictions: { first_time_transaction: "false", minimum_amount: null, minimum_amount_currency: null } })]],
    ["max_redemptions as text", [row({ max_redemptions: "5" })]],
    ["the coupon's max_redemptions as text", [row({}, { max_redemptions: "5" })]],
    ["expires_at as text (a past date)", [row({ expires_at: "1700000000" })]],
    ["the coupon's redeem_by as text", [row({}, { redeem_by: "1700000000" })]],
    ["a page of one row with has_more: true", [row()], { has_more: true }],
    ["a page that does not say whether there is more", [row()], { has_more: undefined }],
  ];
  for (const [what, data, extra] of cases) is(`${what}: not applied`, (await outcome(data, extra)).startsWith("applied"), false);
  done();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
