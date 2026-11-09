/**
 * The payment behind "Support my work" (lib/store-tips.ts): one Stripe
 * checkout on the creator's own account for the amount the visitor chose,
 * and the page they come back to.
 *
 * Built apart from a product's checkout (lib/store-checkout.ts) on purpose.
 * Nothing is sold, so none of a sale's machinery is on it — no discount box,
 * no sale or fair price, no offer to add something, no sales tax, no
 * affiliate's credit and no reminder if the visitor leaves. What it carries is
 * what a list of sales needs to say what it was: the store, `kind: "tip"`, a
 * title, and the message the visitor left on Stripe's page.
 */
import type { Store } from "@/lib/store";
import { saleHandles } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { LANGUAGES } from "@/lib/store-language";
import { inTheCurrencyShown, isSettled, onlyInstantMethods } from "@/lib/instant-pay";
import { isHouseStore } from "@/lib/house-store";
import { tipsWords } from "@/lib/buyer-words/tips";
import { MAX_TIP_MESSAGE, tipInRange } from "@/lib/store-tips";
import { applyShare } from "@/lib/platform-share";

/** What the creator's list of sales calls it, in the studio's English. */
export const TIP_TITLE = "Support";

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const DISPLAY_NAME = "branding_settings[display_name]";

/** Whether this store's page shows the box and can take what is given: switched on, and a till that works. */
export function tipsOpen(store: Store): boolean {
  return store.tips.on && canSell(store);
}

/** Opens the checkout for one gift and returns where to send the visitor. */
export async function createTipCheckout(
  store: Store,
  origin: string,
  amount: number,
  /** The channel this sale is credited to, as Stripe metadata (lib/visit-channel.ts channelOfRequest). */
  channel: Record<string, string> = {},
): Promise<{ url: string; id: string }> {
  if (!tipsOpen(store) || !store.stripeAccountId) throw new Error("This store takes no support");
  // Checked again where the charge is built, whatever the route checked.
  if (!tipInRange(amount, store.currency)) throw new Error("An amount out of range");
  const w = tipsWords(store.language);
  const body = new URLSearchParams({
    mode: "payment",
    locale: LANGUAGES[store.language].stripe,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": store.currency,
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": w.lineName(store.name).slice(0, 250),
    "metadata[store]": store.handle,
    "metadata[kind]": "tip",
    ...Object.fromEntries(Object.entries(channel).map(([key, value]) => [`metadata[${key}]`, value])),
    "metadata[title]": TIP_TITLE,
    "payment_intent_data[metadata][store]": store.handle,
    "payment_intent_data[metadata][kind]": "tip",
    // The visitor's own words to the creator, typed on Stripe's page and
    // listed with the sale (lib/checkout-fields.ts, readAnswers).
    "custom_fields[0][key]": "message",
    "custom_fields[0][label][type]": "custom",
    "custom_fields[0][label][custom]": w.message.slice(0, 50),
    "custom_fields[0][type]": "text",
    "custom_fields[0][optional]": "true",
    "custom_fields[0][text][maximum_length]": String(MAX_TIP_MESSAGE),
    success_url: `${origin}/@${store.handle}/tip?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/@${store.handle}#support`,
  });
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  // The share, when the store's plan has one (lib/platform-share.ts): a tip is
  // money paid through the store like any sale, and nothing comes off it.
  applyShare(body, store, { recurring: false, least: amount });
  // The demo store's test account cannot be renamed, so its page carries the store's name (lib/house-store.ts).
  let named = isHouseStore(store);
  if (named) body.set(DISPLAY_NAME, store.name);

  let session: Record<string, unknown> | null = null;
  while (session === null) {
    try {
      session = await onAccount("POST", store.stripeAccountId, "/checkout/sessions", body);
    } catch (error) {
      if (named && error instanceof StripeError && error.status === 400) {
        body.delete(DISPLAY_NAME);
        named = false;
        continue;
      }
      throw error;
    }
  }
  if (typeof session.url !== "string" || !session.url || typeof session.id !== "string") {
    throw new Error("Stripe did not return a checkout URL");
  }
  return { url: session.url, id: session.id };
}

export type TipOutcome = { state: "paid"; amount: number; currency: string } | { state: "waiting" };

/**
 * What the page a visitor comes back to says: paid, with the amount Stripe
 * took, only for a finished checkout of this store's that was a gift. Anything
 * else — an id that is not one, another store's, a product's, unpaid — is
 * "waiting", which says nothing was confirmed and promises nothing.
 */
export async function readTip(store: Store, sessionId: string): Promise<TipOutcome> {
  if (!store.stripeAccountId || !SESSION_ID_PATTERN.test(sessionId)) return { state: "waiting" };
  try {
    const session = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(sessionId)}`)) as {
      status?: unknown;
      payment_status?: unknown;
      amount_total?: unknown;
      currency?: unknown;
      metadata?: Record<string, string> | null;
    };
    const meta = session.metadata ?? {};
    if (meta.kind !== "tip" || !saleHandles(store).has(meta.store ?? "") || !isSettled(session)) return { state: "waiting" };
    // The amount Stripe took and its currency, as Stripe writes them (a whole number at or above zero, three
    // lowercase letters). One it gave in another shape is not known: "waiting", which confirms nothing, never a
    // thank-you for $0.00 or in the store's currency (CX-123 rule 24).
    const amount = session.amount_total;
    const currency = session.currency;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) {
      console.error("a gift's amount or currency could not be read; its page says nothing was confirmed", store.handle, sessionId);
      return { state: "waiting" };
    }
    return { state: "paid", amount, currency };
  } catch (error) {
    if (!(error instanceof StripeError && error.status === 404)) console.error("reading a gift's checkout failed", error);
    return { state: "waiting" };
  }
}
