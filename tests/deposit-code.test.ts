/**
 * A discount code on a booking with a deposit (520 [LB1], unit 5c; the
 * owner's decision of 2 November 2026, 13h53 Fortaleza; lib/deposit-code.ts,
 * lib/calls.ts callCheckoutBody, app/api/store/book). Checked:
 *
 *   - the code comes off the whole price, never off the deposit alone; the
 *     deposit charged online is the creator's, never more than the
 *     discounted price; the rest in person is the discounted price less it;
 *   - a code Stripe would have to count (a limit on its uses, a first
 *     purchase only, a rule not read here) is refused, as is an inactive,
 *     ended, unreadable or other-currency one, and one leaving less online
 *     than Stripe can charge; unknown is never a discount;
 *   - Stripe is sent the figures with the code, what it took off and the
 *     rest said on its own page before paying, kept on the sale for the
 *     creator's orders, and no code box of its own;
 *   - the code is read from the creator's own account, by exact code, and
 *     anything else read is no code;
 *   - the booking route reads it before any time is held, and the page shows
 *     the field only when a deposit would be charged, in every language.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { depositWithCode, readDepositCode, readDepositCodeRow, type DepositCode } from "@/lib/deposit-code";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { callCheckoutBody } from "@/lib/calls";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { CodeField } from "@/components/slot-picker";
import type { Product, Store } from "@/lib/store";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_deposit_code_only";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const NOW = 1_800_000_000;

const row = (over: Record<string, unknown> = {}, coupon: Record<string, unknown> = {}) => ({
  id: "promo_1",
  code: "SPRING",
  active: true,
  expires_at: null,
  max_redemptions: null,
  restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null },
  promotion: { type: "coupon", coupon: { id: "c1", percent_off: 25, amount_off: null, currency: null, valid: true, max_redemptions: null, redeem_by: null, applies_to: null, ...coupon } },
  ...over,
});

const usd = { priceCents: 8000, deposit: 2000, currency: "usd" as const, nowSeconds: NOW };

async function main(): Promise<void> {
  part("Reading a code");
  const percent = readDepositCodeRow(row()) as DepositCode;
  is("a percent code, with nothing Stripe would have to count", [percent.off, percent.limited, percent.firstOrder, percent.otherRules, percent.minimum], [{ kind: "percent", percent: 25 }, false, false, false, null]);
  const amount = readDepositCodeRow(row({}, { percent_off: null, amount_off: 1500, currency: "USD", currency_options: { eur: { amount_off: 1400 } } })) as DepositCode;
  is("an amount code, with its other currencies", amount.off, { kind: "amount", cents: 1500, currency: "usd", options: { eur: 1400 } });
  is(
    "a limit on uses (its own or its coupon's), a first purchase only, or a rule not read here, is seen",
    [
      readDepositCodeRow(row({ max_redemptions: 10 }))?.limited,
      readDepositCodeRow(row({}, { max_redemptions: 10 }))?.limited,
      readDepositCodeRow(row({ restrictions: { first_time_transaction: true } }))?.firstOrder,
      readDepositCodeRow(row({}, { applies_to: { products: ["prod_1"] } }))?.otherRules,
      readDepositCodeRow(row({}, { redeem_by: NOW + 100 }))?.otherRules,
      readDepositCodeRow(row({}, { valid: false }))?.otherRules,
      readDepositCodeRow(row({ restrictions: { currency_options: { eur: { minimum_amount: 100 } } } }))?.otherRules,
      readDepositCodeRow(row({ restrictions: { minimum_amount: 100, minimum_amount_currency: null } }))?.otherRules,
      readDepositCodeRow(row({ customer: "cus_1" }))?.limited,
      readDepositCodeRow(row({ customer_account: "acct_9" }))?.limited,
    ],
    Array(10).fill(true),
  );
  const unexpanded: Record<string, unknown> = { ...row().promotion.coupon };
  delete unexpanded.applies_to;
  is("a coupon read without its product rule (Stripe sends it only when asked) is a rule not read, never none", readDepositCodeRow(row({ promotion: { coupon: unexpanded } }))?.otherRules, true);
  is("a minimum in one currency is read", readDepositCodeRow(row({ restrictions: { minimum_amount: 5000, minimum_amount_currency: "USD" } }))?.minimum, { cents: 5000, currency: "usd" });
  is("no id, no code, or a coupon not expanded: no code", [readDepositCodeRow(row({ id: "" })), readDepositCodeRow(row({ code: 5 })), readDepositCodeRow(row({ promotion: { coupon: "c1" } }))], [null, null, null]);

  part("The figures: off the whole price");
  is("25% off $80 with a $20 deposit: $20 now, $40 in person", depositWithCode(percent, usd), { ok: true, figures: { off: 2000, discounted: 6000, charged: 2000, rest: 4000 } });
  is(
    "$70 off: the deposit is never more than the discounted price, nothing left",
    depositWithCode(readDepositCodeRow(row({}, { percent_off: null, amount_off: 7000, currency: "usd" })) as DepositCode, usd),
    { ok: true, figures: { off: 7000, discounted: 1000, charged: 1000, rest: 0 } },
  );
  is("in another currency, the coupon's own amount for it", depositWithCode(amount, { ...usd, currency: "eur" }), { ok: true, figures: { off: 1400, discounted: 6600, charged: 2000, rest: 4600 } });
  is("an amount with none for the store's currency is no discount", depositWithCode(amount, { ...usd, currency: "gbp" }), { ok: false, why: "unknown" });
  is(
    "less left online than Stripe can charge is refused, never charged",
    [depositWithCode(readDepositCodeRow(row({}, { percent_off: null, amount_off: 7980, currency: "usd" })) as DepositCode, usd), depositWithCode(readDepositCodeRow(row({}, { percent_off: 100 })) as DepositCode, usd)],
    [{ ok: false, why: "small" }, { ok: false, why: "small" }],
  );
  is(
    "inactive or ended: unknown",
    [depositWithCode({ ...percent, active: false }, usd), depositWithCode({ ...percent, expiresAt: NOW }, usd), depositWithCode({ ...percent, expiresAt: NOW + 60 }, usd).ok],
    [{ ok: false, why: "unknown" }, { ok: false, why: "unknown" }, true],
  );
  is(
    "what Stripe would have to count: refused as such",
    [depositWithCode({ ...percent, limited: true }, usd), depositWithCode({ ...percent, firstOrder: true }, usd), depositWithCode({ ...percent, otherRules: true }, usd)],
    Array(3).fill({ ok: false, why: "limited" }),
  );
  is(
    "a minimum: above the price or in another currency refused; met, used",
    [depositWithCode({ ...percent, minimum: { cents: 9000, currency: "usd" } }, usd), depositWithCode({ ...percent, minimum: { cents: 1000, currency: "eur" } }, usd), depositWithCode({ ...percent, minimum: { cents: 8000, currency: "usd" } }, usd).ok],
    [{ ok: false, why: "unknown" }, { ok: false, why: "unknown" }, true],
  );
  is("a code with nothing off is no discount", depositWithCode({ ...percent, off: null }, usd), { ok: false, why: "unknown" });

  part("What Stripe is sent");
  const place = readSetup({ kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, seats: 1, place: ["Bela Studio"], deposit: 2000 }) as CallSetup;
  const store = { handle: "bela", name: "Bela Studio", language: "en", currency: "usd", hasDiscounts: true, tax: { enabled: false, included: false, ids: false, invoices: false } } as unknown as Store;
  const product = { id: "p1", title: "Haircut", summary: "A cut and a wash.", priceCents: 8000, call: place, fields: [] } as unknown as Product;
  const start = Math.floor((NOW * 1000 + 5 * 86_400_000) / 60_000) * 60_000;
  const send = (figures: { off: number; discounted: number; charged: number; rest: number }, pkg: { id: string; coupon: string; email: string; back: string } | null = null) =>
    callCheckoutBody({ store, product, start, end: start + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: pkg, code: { id: "promo_1", code: "SPRING", figures } });
  const sent = send({ off: 2000, discounted: 6000, charged: 2000, rest: 4000 });
  is(
    "the deposit, the code and the rest said on Stripe's page, and kept on the sale",
    [
      sent.get("line_items[0][price_data][unit_amount]"),
      sent.get("line_items[0][price_data][product_data][description]"),
      sent.get("metadata[deposit]"),
      sent.get("metadata[rest]"),
      sent.get("payment_intent_data[metadata][rest]"),
      sent.get("metadata[price]"),
      sent.get("metadata[code]"),
      sent.get("metadata[code_off]"),
      sent.get("payment_intent_data[metadata][code]"),
    ],
    ["2000", "A cut and a wash. — Code SPRING: $20 off the whole price. A deposit to hold your time. The rest, $40, is paid in person to Bela Studio.", "2000", "4000", "4000", "8000", "SPRING", "2000", "SPRING"],
  );
  is("no code box on Stripe's page: one code, already taken off", sent.get("allow_promotion_codes"), null);
  const whole = send({ off: 7000, discounted: 1000, charged: 1000, rest: 0 });
  is(
    "nothing left in person: the code said, no rest",
    [whole.get("line_items[0][price_data][unit_amount]"), whole.get("line_items[0][price_data][product_data][description]"), whole.get("metadata[rest]"), whole.get("metadata[code]")],
    ["1000", "A cut and a wash. — Code SPRING: $70 off the whole price.", null, "SPRING"],
  );
  const pkg = send({ off: 2000, discounted: 6000, charged: 2000, rest: 4000 }, { id: "pkg1", coupon: "cpn_x", email: "ana@example.com", back: "https://marktmorgen.com/x" });
  is("never on a session from a package: the package was the payment", [pkg.get("line_items[0][price_data][unit_amount]"), pkg.get("metadata[code]"), pkg.get("metadata[rest]")], ["8000", null, null]);
  const long = callCheckoutBody({ store, product: { ...product, summary: "x".repeat(600) } as Product, start, end: start + 3_600_000, buyerTz: NY, origin: "https://marktmorgen.com", via: null, fromPackage: null, code: { id: "promo_1", code: "SPRING", figures: { off: 2000, discounted: 6000, charged: 2000, rest: 4000 } } }).get("line_items[0][price_data][product_data][description]") ?? "";
  is("a long summary is cut so the code and the rest stay whole", [long.length <= 500, long.includes("Code SPRING: $20 off the whole price."), long.endsWith("is paid in person to Bela Studio.")], [true, true, true]);

  part("Reading it from the creator's account");
  const asked: string[] = [];
  let answer: unknown = { data: [row()] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(input)} ${(init?.headers as Record<string, string>)?.["Stripe-Account"] ?? ""}`);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const read = await readDepositCode("acct_1", " spring ");
  is("an active code, by exact code, on the creator's own account", [read?.id, asked.length, (asked[0] ?? "").includes("/promotion_codes?limit=2&active=true&code=SPRING&expand[]=data.promotion.coupon.applies_to&expand[]=data.promotion.coupon.currency_options "), (asked[0] ?? "").endsWith(" acct_1")], ["promo_1", 1, true, true]);
  answer = { data: [row(), row({ id: "promo_2" })] };
  const two = await readDepositCode("acct_1", "SPRING");
  answer = { data: [row({ code: "SPRING2" })] };
  const other = await readDepositCode("acct_1", "SPRING");
  answer = { data: [] };
  const none = await readDepositCode("acct_1", "SPRING");
  const before = asked.length;
  const shape = await readDepositCode("acct_1", "no spaces allowed!");
  is("two, another code, none, or something not a code: no code (and no request for the last)", [two, other, none, shape, asked.length === before], [null, null, null, null, true]);
  globalThis.fetch = (async () => {
    throw new Error("network");
  }) as typeof fetch;
  const origError = console.error;
  console.error = () => {};
  const failed = await readDepositCode("acct_1", "SPRING");
  console.error = origError;
  is("a failed read is no code, never a discount", failed, null);

  part("The booking route and the page");
  const route = readFileSync("app/api/store/book/route.ts", "utf8");
  is("reads the typed code", route.includes('typed = read("code").slice(0, 60);'), true);
  is(
    "only with a deposit to charge, outside a package, and refuses before any time is held",
    [
      route.includes("if (typed.trim() && !pkg && store.hasDiscounts) {"),
      route.includes("if (due.rest > 0) {"),
      route.indexOf('return back(`code-${figured.why}`);') > 0 && route.indexOf('return back(`code-${figured.why}`);') < route.indexOf("const result = await holdAndCheckout({"),
      route.indexOf('if (!found) return back("code-unknown");') < route.indexOf("await releaseOwnHold(store, previous)"),
    ],
    [true, true, true, true],
  );
  is("a code typed but not usable here is said, never dropped quietly", route.includes('if (typed.trim() && !pkg && !code) return back("code-unknown");'), true);
  is("and passes the figures to the checkout", /fromPackage: prepared && prepared\.ok \? prepared\.fromPackage : null,\n\s+code,\n/.test(route), true);
  is("no share figured on codes Stripe's page will not offer", readFileSync("lib/calls.ts", "utf8").includes("store.hasDiscounts && shareBps(store) > 0 && !input.code ? await codesMayTakeOff("), true);
  const { discountKindOf, discountOff } = await import("@/lib/discount-impact");
  const sale = { metadata: { code: "SPRING", code_off: "2000" }, total_details: { amount_discount: 0 } };
  is("the store's discount report counts what the code took off", [discountKindOf(sale), discountOff(sale), discountOff({ metadata: {}, total_details: { amount_discount: 300 } }), discountOff({ metadata: { code_off: "x" } })], ["code", 2000, 300, 0]);
  is("holdAndCheckout hands it to the checkout body", readFileSync("lib/calls.ts", "utf8").includes("lead: input.lead ?? null, code: input.code ?? null });"), true);
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is(
    "the page shows the field only when the checkout would charge a deposit, as the route reads it",
    [page.includes("const due = fromPackage ? null : chargeNow({ priceCents: product.priceCents, currency: store.currency, deposit: setup.deposit ?? null, inPerson: Boolean(setup.place) });") && page.includes("const deposit = due && due.rest > 0 ? due : null;") && page.includes("const code = deposit && store.hasDiscounts ? { label: b.codeLabel, help: b.codeHelp } : undefined;"), (page.match(/, code \}\}/g) ?? []).length],
    [true, 2],
  );
  const field = renderToStaticMarkup(createElement(CodeField, { words: { label: "Discount code (optional)", help: "It comes off the whole price." } }));
  const id = /<label for="([^"]+)"/.exec(field)?.[1] ?? "";
  is("the field is labeled, named code, with its help read with it", [Boolean(id), field.includes(`id="${id}"`), field.includes('name="code"'), field.includes(`aria-describedby="${id}-help"`), field.includes(`id="${id}-help"`)], [true, true, true, true, true]);
  is("not shown when moving a booking or booking from a package", [readFileSync("components/slot-picker.tsx", "utf8").includes("{words.code && !move && !pkg ? <CodeField words={words.code} /> : null}"), readFileSync("components/session-picker.tsx", "utf8").includes("{words.code && !move ? <CodeField words={words.code} /> : null}")], [true, true]);

  part("In every language");
  is(
    "each says the label, the help, what the code took off, and why a code was refused",
    LANGUAGE_CODES.map((code) => {
      const b = bookingWords(code);
      return [code, Boolean(b.codeLabel && b.codeHelp), b.codeOffPrice("SPRING", "20").includes("SPRING"), ["code-unknown", "code-limited", "code-small"].every((key) => Boolean(b.notices[key]?.title && b.notices[key]?.body))];
    }),
    LANGUAGE_CODES.map((code) => [code, true, true, true]),
  );

  done();
}

void main();
