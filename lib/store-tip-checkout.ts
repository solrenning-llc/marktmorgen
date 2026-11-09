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
import { createHash } from "node:crypto";
import type { Store } from "@/lib/store";
import { STORE_ID_PATTERN, saleHandles, storeRef } from "@/lib/store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { canSell } from "@/lib/store-checkout";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { LANGUAGES } from "@/lib/store-language";
import { inTheCurrencyShown, isSettled, onlyInstantMethods } from "@/lib/instant-pay";
import { isHouseStore } from "@/lib/house-store";
import { tipsWords } from "@/lib/buyer-words/tips";
import { MAX_TIP_MESSAGE, tipInRange } from "@/lib/store-tips";
import { applyShare } from "@/lib/platform-share";

export type TipOutcome = { state: "paid"; amount: number; currency: string } | { state: "waiting" };

/** What the creator's list of sales calls it, in the studio's English. */
export const TIP_TITLE = "Support";

const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const DISPLAY_NAME = "branding_settings[display_name]";

/**
 * How long the page a supporter comes back to may ask Stripe about a gift's
 * checkout this store opened (R20 finding 3): a Stripe checkout lives a day
 * at most and its page sends the supporter back at once, so two days covers
 * it, and a return after that says, as for any id, that nothing was confirmed.
 */
export const TIP_MARK_SECONDS = 2 * 86_400;

/**
 * The mark one gift's checkout leaves: named by a hash of the store's own id
 * (its key when it has none yet) and the session id, so it is short, names
 * neither, another store's mark is never this one's, and a supporter coming
 * back after the owner changed their login address still finds it.
 */
function tipMarkKey(store: Store, sessionId: string): string {
  const owner = STORE_ID_PATTERN.test(store.sid) ? `#${store.sid}` : storeRef(store);
  return `nl:tip:co:${createHash("sha256").update(`${owner}|${sessionId}`).digest("hex")}`;
}

/**
 * What the mark holds once Stripe said the gift was paid: the amount and the
 * currency it took, so a reload of the page thanks the supporter without
 * asking Stripe again (review of #3331, Claude 5, LOW 1).
 */
const PAID_MARK = /^paid:(0|[1-9][0-9]{0,14}):([a-z]{3})$/;

type Mark = "opened" | "absent" | Extract<TipOutcome, { state: "paid" }>;

/**
 * What the mark of this session says, read exactly (CX-123 rule 24): the "1"
 * the checkout wrote, opened here; a paid answer remembered from Stripe, that
 * answer; a confirmed absence (null), absent; any other shape throws
 * UnknownReplyError, which the caller takes as not recorded, so an unknown
 * never reaches Stripe and never shows a payment.
 */
async function markOf(store: Store, sessionId: string): Promise<Mark> {
  if (!isRedisConfigured()) return "absent";
  const reply = repliesFor(await redisPipeline([["GET", tipMarkKey(store, sessionId)]]), 1);
  if (reply && reply[0] === "1") return "opened";
  if (reply && reply[0] === null) return "absent";
  const paid = reply && typeof reply[0] === "string" ? PAID_MARK.exec(reply[0]) : null;
  if (paid) return { state: "paid", amount: Number(paid[1]), currency: paid[2] };
  throw new UnknownReplyError("a gift's checkout mark");
}

/**
 * Keeps Stripe's paid answer in the session's mark, for what is left of its
 * two days and never longer: the time left is read first and the answer
 * written only over the mark still there (XX) with exactly that time. A time
 * left or a write Redis does not confirm leaves the mark as it was, and the
 * next reload asks Stripe as before; what this page shows now does not depend
 * on it, Stripe having just said so.
 */
async function rememberPaid(store: Store, sessionId: string, outcome: Extract<TipOutcome, { state: "paid" }>): Promise<void> {
  const value = `paid:${outcome.amount}:${outcome.currency}`;
  if (!PAID_MARK.test(value)) return;
  const key = tipMarkKey(store, sessionId);
  try {
    const left = repliesFor(await redisPipeline([["TTL", key]]), 1);
    const seconds = left ? left[0] : undefined;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > TIP_MARK_SECONDS) return;
    const written = repliesFor(await redisPipeline([["SET", key, value, "XX", "EX", seconds]]), 1);
    if (!written || (written[0] !== "OK" && written[0] !== null)) console.error("remembering a paid gift answered in an unknown shape");
  } catch (error) {
    console.error("remembering a paid gift failed", error);
  }
}

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
  // Recorded before the visitor is sent, so the page they come back to asks
  // Stripe about this session and no other (readTip). A mark Redis does not
  // confirm is a checkout not handed out: the visitor is told it failed and
  // may try again, and the unpaid session expires on Stripe's side.
  const marked = SESSION_ID_PATTERN.test(session.id) && isRedisConfigured()
    ? repliesFor(await redisPipeline([["SET", tipMarkKey(store, session.id), "1", "EX", TIP_MARK_SECONDS]]), 1)
    : null;
  if (!marked || marked[0] !== "OK") throw new Error("The gift's checkout could not be recorded");
  return { url: session.url, id: session.id };
}


/**
 * What the page a visitor comes back to says: paid, with the amount Stripe
 * took, only for a finished checkout of this store's that was a gift. Anything
 * else — an id that is not one, another store's, a product's, unpaid — is
 * "waiting", which says nothing was confirmed and promises nothing.
 *
 * Stripe is asked only about a session this store's tip checkout recorded
 * (createTipCheckout), so a made-up id in the address costs no call on the
 * creator's account (R20 finding 3); a mark that is missing, expired or not
 * read exactly is "waiting" too. Once Stripe said a gift was paid, the mark
 * keeps that answer (rememberPaid) and a reload is thanked from it, with no
 * second call; "paid" is never shown before Stripe said so once.
 */
export async function readTip(store: Store, sessionId: string): Promise<TipOutcome> {
  if (!store.stripeAccountId || !SESSION_ID_PATTERN.test(sessionId)) return { state: "waiting" };
  try {
    const mark = await markOf(store, sessionId);
    if (mark === "absent") return { state: "waiting" };
    if (mark !== "opened") return mark;
  } catch (error) {
    console.error("reading a gift's checkout mark failed", error);
    return { state: "waiting" };
  }
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
    const outcome = {
      state: "paid" as const,
      amount: typeof session.amount_total === "number" ? session.amount_total : 0,
      currency: typeof session.currency === "string" && session.currency ? session.currency : store.currency,
    };
    await rememberPaid(store, sessionId, outcome);
    return outcome;
  } catch (error) {
    if (!(error instanceof StripeError && error.status === 404)) console.error("reading a gift's checkout failed", error);
    return { state: "waiting" };
  }
}
