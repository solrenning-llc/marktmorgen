/**
 * A monthly member moving to the same membership's yearly price, on the
 * creator's own Stripe account (the rules are in lib/yearly-switch-rules.ts).
 *
 *   nl:yearly:price:<account>:<product>:<cents>:<currency>   the yearly price made for switches, reused
 *   nl:yearly:link:<hash>                                     the emailed link to one switch, 14 days
 *
 * The same two steps as a switch between plans (lib/tier-switch.ts), so
 * nothing is charged by surprise:
 *
 *   1. The page asks Stripe what moving costs right now — Stripe's own
 *      preview, prorated to the second: the year's price less what is left
 *      of the month already paid — and says it.
 *   2. The button makes the move at the same second, so the amount charged is
 *      the amount shown. If the card is declined nothing changes and the
 *      invoice is voided. In a free trial nothing is charged now and the
 *      yearly price is charged when the trial ends.
 *
 * The membership stays on the same product: the yearly price names it in its
 * own metadata (lib/tier-rules.ts reads it there), so what the member has
 * open never changes. Reached from the member's page, with the link they ask
 * for there, or from the one email that offers it (lib/yearly-ask.ts), whose
 * link opens this one switch and nothing else.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { CONSENT_META, type DigitalConsent, consentKind, consentMetaValue, deliversDigitally, keepConsentOn, validConsent } from "@/lib/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { type Grant, MANAGE_TOKEN_PATTERN, grantOf, ownedSub } from "@/lib/membership-manage";
import { dueNow, productOfSub } from "@/lib/tier-rules";
import { chargedOf, previewBody, previewKnown, switchBody, switchReply, PREVIEW_SECONDS, SWITCH_STRIPE_VERSION } from "@/lib/tier-switch";
import { type YearlyChoice, type YearlySub, yearlyChoice } from "@/lib/yearly-switch-rules";
import { formatMoney } from "@/lib/money";
import { membershipLine } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import { DEFAULT_LANGUAGE, LANGUAGES, parseLanguage } from "@/lib/store-language";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { forgetPaid } from "@/lib/learn";
import type { Listing, Store } from "@/lib/store";

/** What the switch page and the form ask for, in place of another plan's id. */
export const YEARLY_TARGET = "yearly";
/** How long the emailed link to one switch works. */
export const YEARLY_LINK_SECONDS = 14 * 86_400;

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const PRICE_PATTERN = /^price_[A-Za-z0-9]{6,64}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const linkKey = async (token: string) => `nl:yearly:link:${(await sha256Hex(`nimbus-yearly:${token}`)).slice(0, 40)}`;
const priceKey = (account: string, product: Listing, cents: number, currency: string) => `nl:yearly:price:${account}:${product.id}:${cents}:${currency}`;

/** A link to one membership's switch, for the email that offers it. Opens nothing else. */
export async function mintYearlyLink(store: Store, customer: string, subscription: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await redisPipeline([["SET", await linkKey(token), JSON.stringify({ a: store.stripeAccountId, c: customer, s: subscription }), "EX", YEARLY_LINK_SECONDS]]);
  return token;
}

/** The grant behind a token: the member's own link, or the emailed link for this one membership. */
export async function grantFor(store: Store, token: string, subscription: string): Promise<{ grant: Grant; emailed: boolean } | null> {
  if (!MANAGE_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const manage = await grantOf(store, token);
  if (manage) return { grant: manage, emailed: false };
  const [raw] = await redisPipeline([["GET", await linkKey(token)]]);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as { a?: unknown; c?: unknown; s?: unknown };
    if (value.a !== store.stripeAccountId || typeof value.c !== "string" || value.s !== subscription) return null;
    return { grant: { a: value.a as string, c: value.c, h: store.handle }, emailed: true };
  } catch {
    return null;
  }
}

/** "$20 a month", "$200 a year", in the store's language. */
export function priceWords(store: Store, cents: number, interval: "month" | "year", language: unknown = DEFAULT_LANGUAGE): string {
  const locale = LANGUAGES[parseLanguage(language)].locale;
  return membershipLine({ language, currency: store.currency }, { trialDays: 0, payments: 0, interval }, formatMoney(cents, store.currency, locale));
}

/** The yearly price a membership is moved onto, as Stripe is sent it: it names the same product. */
export function yearlyPriceBody(store: Store, product: Listing, cents: number): URLSearchParams {
  return new URLSearchParams({
    currency: store.currency,
    unit_amount: String(cents),
    "recurring[interval]": "year",
    "product_data[name]": product.title.slice(0, 250),
    "product_data[metadata][store]": store.handle,
    "product_data[metadata][product]": product.id,
    // Read at every door: the product this price hands over (lib/tier-rules.ts).
    "metadata[product]": product.id,
    "metadata[store]": store.handle,
    "metadata[every]": "year",
    "metadata[made_by]": "nimbus-labs",
  });
}

/** The yearly price, made once on the creator's account for each amount and reused. */
export async function yearlyPrice(store: Store, product: Listing, cents: number): Promise<string> {
  const account = store.stripeAccountId as string;
  const key = priceKey(account, product, cents, store.currency);
  const [cached] = await redisPipeline([["GET", key]]);
  if (typeof cached === "string" && PRICE_PATTERN.test(cached)) return cached;
  const made = await onAccount("POST", account, "/prices", yearlyPriceBody(store, product, cents));
  const id = typeof made.id === "string" ? made.id : "";
  if (!PRICE_PATTERN.test(id)) throw new Error("Stripe returned no price");
  await redisPipeline([["SET", key, id, "EX", 400 * 86_400]]);
  return id;
}

export type YearlyPreview = {
  sub: string;
  title: string;
  /** "$20 a month" and "$200 a year". */
  monthlyWords: string;
  yearlyWords: string;
  /** What a year saves against twelve of the member's monthly payments. */
  saving: number;
  /** Charged now: the year less what is left of the month already paid. */
  due: number;
  currency: string;
  trialing: boolean;
  at: number;
  /** Whether the membership is handed over digitally at once: then the page asks the EU box again (91 [D2-EU-WITHDRAWAL]). */
  digital: boolean;
};

export type YearlyProblemReason = "expired" | "gone" | "yearly" | "error";
export type YearlyPreviewResult = { ok: true; preview: YearlyPreview; emailed: boolean } | { ok: false; reason: YearlyProblemReason; emailed: boolean };

type Found = { grant: Grant; emailed: boolean; itemId: string; product: Listing; choice: YearlyChoice; trialing: boolean };

async function find(store: Store, token: string, subscription: string): Promise<Found | { reason: "expired" | "gone" | "yearly"; emailed: boolean }> {
  if (!SUB_PATTERN.test(subscription)) return { reason: "gone", emailed: false };
  const granted = await grantFor(store, token, subscription);
  if (!granted) return { reason: "expired", emailed: false };
  const { emailed } = granted;
  // Among every customer the link manages; `grant` is then the one who holds it (R43 F1 on #2985).
  const owned = await ownedSub(store, granted.grant, subscription);
  const grant = owned?.grant ?? granted.grant;
  const sub = owned?.sub as (YearlySub & { id?: unknown; items?: { data?: { id?: unknown }[] } }) | undefined;
  if (!sub) return { reason: "gone", emailed };
  const itemId = typeof sub.items?.data?.[0]?.id === "string" ? (sub.items.data[0].id as string) : "";
  if (!itemId) return { reason: "gone", emailed };
  const productId = productOfSub(sub as Parameters<typeof productOfSub>[0]);
  const [product] = productId ? await readListings(store, [productId]).catch(() => [] as Listing[]) : [];
  if (!product || !canSellProduct(store, product)) return { reason: "yearly", emailed };
  const choice = yearlyChoice(sub, product, store.tiers, store.currency, Math.floor(Date.now() / 1000));
  if (!choice) return { reason: "yearly", emailed };
  return { grant, emailed, itemId, product, choice, trialing: sub.status === "trialing" };
}

/** What moving to yearly would cost right now, in Stripe's own figures. Changes nothing. */
export async function previewYearly(store: Store, token: string, subscription: string): Promise<YearlyPreviewResult> {
  if (!isRedisConfigured() || !store.stripeAccountId) return { ok: false, reason: "error", emailed: false };
  let emailed = false;
  try {
    const found = await find(store, token, subscription);
    emailed = found.emailed;
    if ("reason" in found) return { ok: false, reason: found.reason, emailed };
    const price = await yearlyPrice(store, found.product, found.choice.cents);
    const at = Math.floor(Date.now() / 1000);
    const invoice = await onAccount("POST", found.grant.a, "/invoices/create_preview", previewBody(found.grant.c, subscription, found.itemId, price, at));
    // Read exactly first, as a switch between tiers reads it (lib/tier-switch.ts, previewKnown; Codex J on #2764).
    if (!previewKnown(invoice)) {
      console.error("a move to yearly's preview was not one this code knows", subscription);
      return { ok: false, reason: "error", emailed };
    }
    const due = dueNow(invoice as Parameters<typeof dueNow>[0], at);
    return {
      ok: true,
      emailed,
      preview: {
        sub: subscription,
        title: found.product.title,
        monthlyWords: priceWords(store, found.choice.monthly, "month", store.language),
        yearlyWords: priceWords(store, found.choice.cents, "year", store.language),
        saving: found.choice.saving,
        due: found.trialing ? 0 : Math.max(0, due),
        currency: typeof invoice.currency === "string" ? invoice.currency : store.currency,
        trialing: found.trialing,
        at,
        digital: deliversDigitally(found.product),
      },
    };
  } catch (error) {
    if (!(error instanceof StripeError)) console.error("previewing a move to yearly failed", error);
    return { ok: false, reason: "error", emailed };
  }
}

export type YearlyResult =
  | { ok: true; title: string }
  | { ok: false; reason: "expired" | "gone" | "yearly" | "stale" | "declined" | "busy" | "consent" | "unconfirmed" | "error" };

/**
 * Moves the membership to yearly, at the second the preview was worked out
 * for. It charges at once under new terms, so it asks the buyer's yes again,
 * as a switch between tiers does (lib/tier-switch.ts; 91 [D2-EU-WITHDRAWAL]).
 */
export async function switchYearly(store: Store, token: string, subscription: string, at: number, consent: DigitalConsent | null): Promise<YearlyResult> {
  if (!isRedisConfigured() || !store.stripeAccountId) return { ok: false, reason: "error" };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(at) || at > now + 60 || now - at > PREVIEW_SECONDS) return { ok: false, reason: "stale" };
  try {
    // The same lock as a switch between plans: one change to a membership at a time.
    return await withLock(`nl:tier:${subscription}:lock`, 60, 5_000, async (): Promise<YearlyResult> => {
      const found = await find(store, token, subscription);
      if ("reason" in found) return { ok: false, reason: found.reason };
      const digital = deliversDigitally(found.product);
      if (digital && !validConsent(consent)) return { ok: false, reason: "consent" };
      const account = found.grant.a;
      const price = await yearlyPrice(store, found.product, found.choice.cents);
      const body = switchBody(found.itemId, price, at);
      const kept = digital && validConsent(consent) ? consentMetaValue(consent, consentKind(found.product)) : "";
      if (digital && validConsent(consent)) keepConsentOn(body, consent, consentKind(found.product));
      let updated: Record<string, unknown>;
      try {
        updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, body, SWITCH_STRIPE_VERSION);
      } catch (error) {
        // Stripe answered a refusal (below 500): nothing was applied, said as before. No answer at all, or Stripe's own
        // failure, after the update was sent: it may have been applied, so it is "unconfirmed", never "nothing changed"
        // (Codex CX1 on #2764). Nothing is sent again.
        if (error instanceof StripeError && error.status < 500) throw error;
        console.error("a move to yearly's charging update had no answer that can be read", error);
        return { ok: false, reason: "unconfirmed" };
      }
      // Read exactly, as a switch between tiers reads it (lib/tier-switch.ts, switchReply; Codex CX1 on #2764).
      const answered = switchReply(updated, subscription, price, kept);
      if (answered === "unknown") {
        console.error("a move to yearly's reply was not one this code knows", subscription);
        return { ok: false, reason: "unconfirmed" };
      }
      if (answered === "pending") {
        const invoice = updated.latest_invoice as { id?: unknown; status?: unknown } | null;
        if (invoice && typeof invoice.id === "string" && invoice.status === "open") {
          await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice.id)}/void`, new URLSearchParams()).catch((error) =>
            console.error("voiding a declined move to yearly failed", error),
          );
        }
        return { ok: false, reason: "declined" };
      }
      // As a membership bought yearly says it (lib/store-checkout.ts).
      await onAccount(
        "POST",
        account,
        `/subscriptions/${encodeURIComponent(subscription)}`,
        new URLSearchParams({ "metadata[every]": "year", "metadata[yearly_from]": "month", "metadata[yearly_at]": String(now) }),
      ).catch((error) => console.error("recording a move to yearly failed", error));
      await tell(store, account, found, updated, kept);
      return { ok: true, title: found.product.title };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    if (!(error instanceof StripeError)) console.error("moving a membership to yearly failed", error);
    return { ok: false, reason: "error" };
  }
}

/** The member's receipt, in the store's language, and the creator's note, in English. */
async function tell(store: Store, account: string, found: Found, updated: Record<string, unknown>, kept: string): Promise<void> {
  let email = "";
  try {
    const customer = await onAccount("GET", account, `/customers/${encodeURIComponent(found.grant.c)}`);
    email = typeof customer.email === "string" ? customer.email : "";
  } catch (error) {
    console.error("reading a member's address failed", error);
  }
  if (!email) return;
  await forgetPaid(store, email).catch(() => {});
  // Read exactly, as a switch between tiers reads it (lib/tier-switch.ts, chargedOf): an invoice that cannot be read
  // says nothing about the amount, never that nothing was charged (Codex CX1 on #2764).
  const charged = found.trialing ? null : chargedOf(updated.latest_invoice);
  const total = charged?.cents ?? 0;
  const currency = charged?.currency ?? store.currency;
  const m = membershipWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const paid = found.trialing ? m.yearlyPaidTrial : !charged ? "" : total > 0 ? m.yearlyPaidCharged(formatMoney(total, currency, locale)) : m.paidNothing;
  const from = `"${m.fromName(store.name.replace(/["\\<>\r\n]/g, "").slice(0, 60))}" <${(NIMBUS_FROM.match(/<([^>]+)>/)?.[1] ?? NIMBUS_FROM).trim()}>`;
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from,
    to: email,
    subject: m.yearlySubject(found.product.title).slice(0, 200),
    text: [
      m.yearlyNow(store.name, found.product.title),
      "",
      ...(paid ? [paid] : []),
      m.fromNow(priceWords(store, found.choice.cents, "year", store.language)),
      // The yes given for this move, quoted as a checkout's confirmation quotes it (the durable medium).
      ...consentEmailLines(store, kept ? { [CONSENT_META]: kept } : null),
      "",
      m.switchedFooter(store.name),
    ].join("\n"),
    replyTo: store.email,
  }).catch((error) => console.error("a move to yearly receipt failed", error));
  if (store.email) {
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: NIMBUS_FROM,
      to: store.email,
      subject: `A member now pays yearly for ${found.product.title}`.slice(0, 200),
      text: [
        `${email} moved their ${found.product.title} membership from ${priceWords(store, found.choice.monthly, "month")} to ${priceWords(store, found.choice.cents, "year")}.`,
        found.trialing
          ? "They are in their free trial; the yearly price is charged when it ends."
          : !charged
            ? "The amount charged could not be read here; Stripe has it."
            : total > 0
              ? `Charged today: ${formatMoney(total, currency)}, the year less what was left of their last monthly payment.`
              : "",
        "",
        "It is all on your own Stripe account, under that customer.",
      ].filter(Boolean).join("\n"),
    }).catch((error) => console.error("a move to yearly note failed", error));
  }
}
