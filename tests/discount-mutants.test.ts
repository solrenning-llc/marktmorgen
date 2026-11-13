/**
 * Mutation testing of lib/discount.ts (Claude 7, 13/11/2026): each case kills a
 * mutant that survived every test reaching the module. codesMayTakeOff sets how
 * much a code may take off a checkout, which bounds the platform's share of the
 * sale (lib/platform-share.ts): an unread page or row must stay unknown, and the
 * largest percent and the largest amount in the store's currency must come back.
 * The module is imported after the mock base is set: lib/stripe-account.ts
 * reads it once, at import.
 */
import { done, is, part } from "./check";

const originalFetch = globalThis.fetch;
const priorKey = process.env.STRIPE_SECRET_KEY;
const priorBase = process.env.STRIPE_CONNECT_API_BASE;
process.env.STRIPE_SECRET_KEY = "sk_test_local_discount_mutants_only";
process.env.STRIPE_CONNECT_API_BASE = "http://127.0.0.1:4998";
let body: unknown = { data: [] };
let requests = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (!url.startsWith("http://127.0.0.1:4998/")) throw Error("Unexpected external provider request");
  requests++;
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const ACCOUNT = "acct_synthetic_discount_mutants";
const percent = (n: unknown) => ({ id: `promo_p${String(n)}`, code: `P${String(n)}`, active: true, promotion: { coupon: { percent_off: n } } });
const amount = (n: unknown, currency: unknown = "usd") => ({ id: `promo_a${String(n)}${String(currency)}`, code: `A${String(n)}`, active: true, promotion: { coupon: { amount_off: n, currency } } });

async function main() {
  try {
    const { CODE_PROBLEMS, amountProblem, codeProblem, codesMayTakeOff, listCodes, livePromotionId, offLabel } = await import("@/lib/discount");

    part("Words");
    is("the dollar's amount sentence", amountProblem("usd"), CODE_PROBLEMS.amount);
    is("another currency names itself", amountProblem("eur").includes("in EUR"), true);
    is("an empty code is empty, not a bad shape", codeProblem(""), "empty");
    is("a percent label", offLabel({ kind: "percent", percent: 20 }), "20% off");
    is("an amount label", offLabel({ kind: "amount", cents: 1000, currency: "eur" }), "€10 off");

    part("What the codes may take off a checkout");
    requests = 0;
    is("no account is unknown, without asking", await codesMayTakeOff(null, "usd"), [{ kind: "unknown" }]);
    is("nothing was asked", requests, 0);
    body = { data: [percent(10), percent(25), amount(500), amount(1500), amount(9000, "eur")] };
    is("the largest percent and the largest amount in the store's currency", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "percent", percent: 25 }, { kind: "cents", cents: 1500 }]);
    is("currency compared without case", await codesMayTakeOff(ACCOUNT, "EUR"), [{ kind: "percent", percent: 25 }, { kind: "cents", cents: 9000 }]);
    body = { data: [amount(700)] };
    is("only an amount: no percent line", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "cents", cents: 700 }]);
    body = { data: [percent(15)] };
    is("only a percent: no amount line", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "percent", percent: 15 }]);
    body = { data: [] };
    is("no live codes: nothing comes off", await codesMayTakeOff(ACCOUNT, "usd"), []);
    body = { data: [percent(10)], has_more: true };
    is("a page that says more follow is unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { has_more: false };
    is("a page with no list is unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { data: [percent(10), { id: "promo_x", code: "X", promotion: { coupon: "coupon_unexpanded" } }] };
    is("one row whose coupon cannot be read is unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { data: [percent(0)] };
    is("a zero percent coupon cannot be read: unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { data: [percent("20")] };
    is("a percent written as text: unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { data: [amount(0)] };
    is("a zero amount coupon: unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);
    body = { data: [amount("500")] };
    is("an amount written as text: unknown", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "unknown" }]);

    part("What a listed code reads as");
    const one = async (row: Record<string, unknown>) => {
      body = { data: [{ id: "promo_one", code: "ONE", active: true, ...row }] };
      const list = await listCodes(ACCOUNT);
      return list.state === "ok" ? list.codes[0] : list;
    };
    is("an amount in euros keeps its currency", (await one({ promotion: { coupon: { amount_off: 500, currency: "eur" } } }))?.off, { kind: "amount", cents: 500, currency: "eur" });
    is("an amount with an empty currency is the dollar", (await one({ promotion: { coupon: { amount_off: 500, currency: "" } } }))?.off, { kind: "amount", cents: 500, currency: "usd" });
    is("repeating for zero months is not read", (await one({ promotion: { coupon: { percent_off: 5, duration: "repeating", duration_in_months: 0 } } }))?.duration, null);
    is("an unknown duration with months is not read", (await one({ promotion: { coupon: { percent_off: 5, duration: "someday", duration_in_months: 3 } } }))?.duration, null);
    const zeroMinimum = await one({ restrictions: { minimum_amount: 0, minimum_amount_currency: "usd" } });
    is("a zero minimum is not a minimum, and is said as another rule", [zeroMinimum?.minimum, zeroMinimum?.otherRules], [null, true]);
    is("empty currency options are no other rule", (await one({ restrictions: { currency_options: {} } }))?.otherRules, false);
    is("an expiry is read", (await one({ expires_at: 1_800_000_000 }))?.expiresAt, 1_800_000_000);
    is("an id that is not text refuses the list", await one({ id: 5 }), { state: "error" });
    is("a code that is not text refuses the list", await one({ code: 5 }), { state: "error" });

    part("A code from a link");
    body = { data: [{ id: "promo_live", code: "LAUNCH20", active: true }] };
    is("a live code", await livePromotionId(ACCOUNT, "LAUNCH20"), "promo_live");
    requests = 0;
    is("a code in no valid shape is never asked for", await livePromotionId(ACCOUNT, "not a code!"), null);
    is("and nothing was asked", requests, 0);
    body = { data: [{ id: "promo_off", code: "LAUNCH20", active: false }] };
    is("a code Stripe says is off", await livePromotionId(ACCOUNT, "LAUNCH20"), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = priorKey;
    if (priorBase === undefined) delete process.env.STRIPE_CONNECT_API_BASE;
    else process.env.STRIPE_CONNECT_API_BASE = priorBase;
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
