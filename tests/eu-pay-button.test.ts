/**
 * The buttons that place an order with an obligation to pay say so (EU
 * consumer audit, 6 November 2026, row 11; Directive 2011/83/EU art. 8(2):
 * "labelled ... only with the words 'order with obligation to pay' or a
 * corresponding unambiguous formulation"). Checked:
 *
 *   - the one-click offer after paying (lib/buyer-words/thanks.ts, `yesAdd`,
 *     drawn on app/[handle]/thanks/page.tsx) charges the card at once, so in
 *     every buyer language its label holds a word that plainly means buying
 *     or paying, and still shows the amount; "add it" alone does not;
 *   - the cart's Stripe Checkout session (lib/cart-checkout.ts, payment mode)
 *     asks Stripe for its paying label, `submit_type=pay`, rather than
 *     leaving the button to Stripe's default.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { NO_RECOVERY } from "@/lib/recovery-setting";
import { createCartCheckout } from "@/lib/cart-checkout";
import { NO_DEAL } from "@/lib/cart-rules";
import { NO_SALE } from "@/lib/store-sale";
import type { LanguageCode } from "@/lib/store-language";
import type { Product, Store } from "@/lib/store";
import { done, is, part } from "./check";

/** Words that, on a button, unambiguously mean the press is a purchase to be paid for. "Order" or "add" alone is not one. */
const PAYING_WORDS: Record<LanguageCode, string[]> = {
  en: ["buy", "pay", "purchase"],
  es: ["comprar", "compra", "pagar", "paga"],
  fr: ["acheter", "achetez", "payer", "payez"],
  de: ["kaufen", "zahlen", "bezahlen", "kostenpflichtig"],
  it: ["acquista", "acquistare", "compra", "comprare", "paga", "pagare"],
  nl: ["kopen", "koop", "betalen", "betaal"],
  pt: ["comprar", "compre", "pagar", "pague"],
};

function hasPayingWord(label: string, words: string[]): boolean {
  const tokens = label.toLocaleLowerCase().split(/[^\p{L}]+/u);
  return words.some((word) => tokens.includes(word));
}

const sent: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
    sent.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: "cs_test_paybtn00000001", url: "https://checkout.stripe.com/c/pay/cs_test_paybtn00000001" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const product = (id: string, priceCents: number) =>
  ({ id, title: `Guide ${id}`, summary: "", priceCents, recurring: null, call: null, callPackage: null, podcast: null, options: [], pwyw: null, stock: null, bundle: null, pick: null, course: null, file: null, link: `https://example.com/${id}`, hidden: false, fields: [], keys: null }) as unknown as Product;

const shop = {
  handle: "bakery",
  name: "Oven Notes",
  email: "owner@example.com",
  language: "en",
  currency: "usd",
  stripeAccountId: "acct_test_paybtn01",
  sale: { ...NO_SALE },
  cartDeal: { ...NO_DEAL },
  recovery: { ...NO_RECOVERY },
  fair: undefined,
  hasDiscounts: true,
  tax: { enabled: false, included: false, ids: false, invoices: false },
  affiliates: { enabled: false, percent: 0, days: 30, rates: {}, payday: 0, hold: 0 },
  catalog: { id: null, items: [], head: [], inline: null },
} as unknown as Store;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("The one-click offer's button says the press is a purchase");
  const languages = Object.keys(PAYING_WORDS) as LanguageCode[];
  is("every buyer language has its paying words here", Object.keys(THANKS_WORDS).sort(), [...languages].sort());
  for (const language of languages) {
    const label = THANKS_WORDS[language].yesAdd("€12.00");
    is(`${language}: "${label}" holds a paying word`, hasPayingWord(label, PAYING_WORDS[language]), true);
    is(`${language}: and still shows the amount`, label.includes("€12.00"), true);
  }

  part("The cart's Stripe Checkout asks for its paying label");
  await createCartCheckout(shop, [product("a", 1900), product("b", 900)], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const body = sent.at(-1) as URLSearchParams;
  is("a one-off payment", body.get("mode"), "payment");
  is("with submit_type pay, Stripe's 'Buy' label", body.get("submit_type"), "pay");

  done();
}

void main();
