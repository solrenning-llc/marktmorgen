/**
 * A member switching their membership to another tier, up or down, on the
 * creator's own Stripe account (the rules are in lib/tier-rules.ts).
 *
 *   nl:tier:price:<account>:<product>:<amount>:<currency>:<interval>   the price made for a tier, reused
 *
 * From the member's own page (lib/membership-manage.ts), reached by the link
 * emailed to the address they pay with. Two steps, so nothing is charged by
 * surprise:
 *
 *   1. The page for one switch asks Stripe what it would cost right now —
 *      Stripe's own preview of the invoice, prorated to the second — and
 *      says it: "$12.40 today", or "$8.10 comes off your next payments".
 *   2. The button makes that switch at the same second the preview used, so
 *      the amount charged is the amount shown. The card on file is charged at
 *      once; if it is declined nothing changes and the invoice is voided.
 *
 * The switch replaces the subscription's price with one made for the new
 * tier, which names its product in its own metadata. Every door reads the
 * tier from there (lib/tier-rules.ts, currentMeta), so what the member pays
 * and what they get change together. In a free trial nothing is charged now
 * and the new price starts when the trial ends. A member keeps whatever
 * discount their membership already had.
 *
 * A member who paid and was given free days (lib/member-free-days.ts) reads
 * "trialing" on Stripe, which prorates nothing in a trial: a switch then would
 * hand the new tier over for nothing until the free days end. So it is refused
 * while they run ("freeDays"), and the page says why; it opens again with the
 * next charge (Claude 4 team review of #2912, A1).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { CONSENT_META, type DigitalConsent, consentKind, consentMetaValue, deliversDigitally, keepConsentOn, validConsent } from "@/lib/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { type Membership, endsAtOf, grantOf, subscriptionCurrency, subsOf } from "@/lib/membership-manage";
import { canTier, direction, dueNow, productOfSub } from "@/lib/tier-rules";
import { formatMoney } from "@/lib/money";
import { inPaidFreeDays } from "@/lib/member-free-days-rules";
import { membershipLine } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import { DEFAULT_LANGUAGE, LANGUAGES, parseLanguage } from "@/lib/store-language";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { forgetPaid } from "@/lib/learn";
import { forgetTicket } from "@/lib/community-access";
import type { Listing, Store } from "@/lib/store";

const SUB_PATTERN = /^sub_[A-Za-z0-9]{6,64}$/;
const PRICE_PATTERN = /^price_[A-Za-z0-9]{6,64}$/;
/** States a membership can switch from: running and paid up, or in its trial. */
const SWITCHABLE = new Set(["active", "trialing"]);
/** A preview is honored for this long, so a member who reads it slowly pays what they read. */
export const PREVIEW_SECONDS = 15 * 60;

/** How a price made here treats tax, as checkout's own price data does (lib/tax.ts, applyTax): none when tax is off. */
const taxMode = (store: Store): "inclusive" | "exclusive" | "" => (store.tax.enabled ? (store.tax.included ? "inclusive" : "exclusive") : "");
/** One cached price per product, amount, currency, interval and tax treatment: a price's tax behavior never changes. */
const priceKey = (account: string, product: Listing, currency: string, tax: string) =>
  `nl:tier:price:${account}:${product.id}:${product.priceCents}:${currency}:${product.recurring?.interval ?? ""}${tax ? `:${tax}` : ""}`;

/** The tiers members can switch between today: still memberships, still on sale. */
export async function liveTiers(store: Store): Promise<Listing[]> {
  if (store.tiers.length < 2) return [];
  const listed = await readListings(store, store.tiers).catch(() => [] as Listing[]);
  const byId = new Map(listed.map((p) => [p.id, p]));
  return store.tiers
    .map((id) => byId.get(id))
    .filter((p): p is Listing => Boolean(p && !p.hidden && canTier(p) && canSellProduct(store, p)));
}

/** A tier as the member's page offers it. */
export type TierChoice = { id: string; title: string; words: string; way: "up" | "down" | "same" };

/**
 * What price a tier is sold at, said the way the store page says it, without
 * the trial. In English unless a language is asked for: the studio reads it
 * too, and the studio is in English; a member is told it in the store's
 * language (store.language).
 */
export function tierWords(store: Store, product: Listing, language: unknown = DEFAULT_LANGUAGE): string {
  if (!product.recurring) return "";
  const locale = LANGUAGES[parseLanguage(language)].locale;
  return membershipLine({ language, currency: store.currency }, { ...product.recurring, trialDays: 0 }, formatMoney(product.priceCents, store.currency, locale));
}

/** The tiers one membership can switch to; none when it cannot switch at all. */
export function choicesFor(store: Store, membership: Membership, tiers: Listing[]): TierChoice[] {
  if (membership.endsAt !== null || membership.fixedEnd || !SWITCHABLE.has(membership.status)) return [];
  // Paid in another currency than the store's now (it changed its currency since): every tier is
  // priced in the store's, so a switch would change the subscription's currency. None is offered.
  if (membership.currency.toLowerCase() !== store.currency) return [];
  const from = tiers.find((t) => t.id === membership.product);
  if (!from?.recurring) return [];
  return tiers
    .filter((t) => t.id !== from.id && t.recurring)
    .map((t) => ({
      id: t.id,
      title: t.title,
      words: tierWords(store, t, store.language),
      way: direction({ priceCents: membership.amount, interval: membership.interval }, { priceCents: t.priceCents, interval: t.recurring!.interval }),
    }));
}

/** The price a tier is switched onto, as Stripe is sent it: it names the product it hands over. */
export function tierPriceBody(store: Store, product: Listing): URLSearchParams {
  const body = new URLSearchParams({
    currency: store.currency,
    unit_amount: String(product.priceCents),
    "recurring[interval]": product.recurring?.interval ?? "month",
    "product_data[name]": product.title.slice(0, 250),
    "product_data[metadata][store]": store.handle,
    "product_data[metadata][product]": product.id,
    // Read at every door: the product this price hands over (lib/tier-rules.ts).
    "metadata[product]": product.id,
    "metadata[store]": store.handle,
    "metadata[made_by]": "nimbus-labs",
  });
  // With Stripe Tax on, the price says whether tax is inside it or on top, as every checkout line does
  // (lib/tax.ts, applyTax); a price left unspecified would be charged as the account's default, not the store's.
  const tax = taxMode(store);
  if (tax) body.set("tax_behavior", tax);
  return body;
}

/** Stripe's preview of a switch, worked out at the second `at`. */
export function previewBody(customer: string, subscription: string, itemId: string, price: string, at: number): URLSearchParams {
  return new URLSearchParams({
    customer,
    subscription,
    "subscription_details[items][0][id]": itemId,
    "subscription_details[items][0][price]": price,
    "subscription_details[proration_behavior]": "always_invoice",
    "subscription_details[proration_date]": String(at),
  });
}

/**
 * What Stripe answered to the update that charges, read exactly (CX-123 rule
 * 24; Codex CX1 on #2764): "applied" only for this subscription, with no
 * update left pending, its first item on the new price and, when a yes was
 * sent, that yes kept on it; "pending" for this subscription with an update
 * left pending (declined, or the bank asked for a step); anything else
 * "unknown", never a switch made: no record, no receipt, no ok.
 */
export function switchReply(updated: unknown, subscription: string, price: string, consent: string): "applied" | "pending" | "unknown" {
  if (!updated || typeof updated !== "object" || Array.isArray(updated)) return "unknown";
  const reply = updated as Record<string, unknown>;
  if (reply.id !== subscription) return "unknown";
  const pending = reply.pending_update;
  if (pending && typeof pending === "object" && !Array.isArray(pending)) return "pending";
  if (pending !== null) return "unknown";
  const items = (reply.items as { data?: unknown } | null | undefined)?.data;
  const first = Array.isArray(items) ? (items[0] as { price?: unknown } | undefined) : undefined;
  const priceId = first?.price && typeof first.price === "object" ? (first.price as { id?: unknown }).id : first?.price;
  if (priceId !== price) return "unknown";
  if (consent) {
    const meta = reply.metadata;
    if (!meta || typeof meta !== "object" || (meta as Record<string, unknown>).dc !== consent) return "unknown";
  }
  return "applied";
}

/**
 * The API version the charging update is sent with (Codex CX1 on #2764): it
 * carries the buyer's yes as metadata with payment_behavior=
 * pending_if_incomplete, which Stripe accepts only from 2026-05-27.dahlia
 * (docs.stripe.com/changelog/dahlia/2026-05-27/pending-subscription-update-metadata;
 * before it, an error), so the account's own default never decides. The
 * same version as lib/yearly-fallback.ts, which sends the same combination.
 */
export const SWITCH_STRIPE_VERSION = "2026-08-26.dahlia";

/**
 * What the switch's invoice charged, read exactly (Codex CX1 on #2764; CX-123
 * rule 24): the expanded invoice, its total in whole cents, its currency and,
 * above zero, what the card paid after any credit, in whole cents. Anything
 * else is unknown (null): the receipt then says nothing about the amount,
 * never that nothing was charged.
 */
export function chargedOf(invoice: unknown): { cents: number; currency: string } | null {
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) return null;
  const { total, amount_paid: paid, currency } = invoice as Record<string, unknown>;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || typeof currency !== "string" || !currency) return null;
  if (total <= 0) return { cents: total, currency };
  if (typeof paid !== "number" || !Number.isSafeInteger(paid) || paid < 0) return null;
  return { cents: paid, currency };
}

/**
 * Whether Stripe's invoice preview can be read for the amount a switch
 * charges now (Codex J on #2764; CX-123 rule 24): its currency, a starting
 * balance in whole cents or none, and a whole list of lines (has_more false:
 * Stripe sends it on every list, so a list without it, or one that goes on, is
 * not known to hold every line, and no further page is read), each with its amount
 * and the start of its period in whole numbers, and its discounts and taxes,
 * when it has them, each with a whole amount. Anything else is unknown: the
 * page then says Stripe could not work out the price, never that nothing is
 * charged today (dueNow in lib/tier-rules.ts reads a missing number as 0).
 */
export function previewKnown(invoice: unknown): boolean {
  const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const amounts = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.every((one) => record(one) && whole(one.amount)));
  if (!record(invoice) || typeof invoice.currency !== "string" || !invoice.currency) return false;
  if (invoice.starting_balance !== undefined && invoice.starting_balance !== null && !whole(invoice.starting_balance)) return false;
  if (!record(invoice.lines) || invoice.lines.has_more !== false) return false;
  const lines = invoice.lines.data;
  if (!Array.isArray(lines)) return false;
  return lines.every((line) => record(line) && whole(line.amount) && record(line.period) && whole(line.period.start) && amounts(line.discount_amounts) && amounts(line.taxes) && amounts(line.tax_amounts));
}

/** The switch itself, at the same second: charged at once, and made only if it is paid. */
export function switchBody(itemId: string, price: string, at: number): URLSearchParams {
  const body = new URLSearchParams({
    "items[0][id]": itemId,
    "items[0][price]": price,
    proration_behavior: "always_invoice",
    proration_date: String(at),
    payment_behavior: "pending_if_incomplete",
  });
  body.append("expand[]", "latest_invoice");
  return body;
}

/**
 * The Idempotency-Key of a switch's charging update (lib/yearly-switch.ts too): the membership, the preview's second
 * and the price it moves onto. A retry of the same switch sends the same key, so Stripe answers it with the first
 * request's result, or a 409 while that one still runs, never with a second charge. PREVIEW_SECONDS (15 minutes)
 * keeps every retry inside the 24 hours Stripe keeps a key; an older preview is "stale", and the new one reads the
 * subscription again before anything is sent.
 */
export function switchKey(subscription: string, at: number, price: string): string {
  return `switch:${subscription}:${at}:${price}`;
}

/**
 * Whether Stripe's refusal of a switch's charging update says that nothing was applied: a 4xx, except a 409 (the
 * first request with this key still running) and an idempotency_error (this key already sent with other parameters,
 * as when the EU box is ticked again, so the yes has another second). Those two may stand for a switch already made:
 * "unconfirmed", never "nothing changed".
 */
export function refusedUnapplied(error: unknown): error is StripeError {
  return (
    error instanceof StripeError &&
    error.status < 500 &&
    error.status !== 409 &&
    error.code !== "idempotency_error" &&
    error.code !== "idempotency_key_in_use"
  );
}

/**
 * After an unconfirmed switch the membership's lock is held a full 60 seconds from that answer (withLock, keepFullTerm,
 * whatever the reads before the charge took) and left to run out rather than let go: a new preview, whose new second makes a new key, is "busy" while the first
 * request may still be running at Stripe, and is read again afterwards.
 */
export function keepWhileUnconfirmed(result: { ok: boolean; reason?: string }): boolean {
  return !result.ok && result.reason === "unconfirmed";
}

/** The price a tier is switched onto, made once on the creator's account and reused. */
export async function tierPrice(store: Store, product: Listing): Promise<string> {
  const account = store.stripeAccountId as string;
  const key = priceKey(account, product, store.currency, taxMode(store));
  const [cached] = await redisPipeline([["GET", key]]);
  if (typeof cached === "string" && PRICE_PATTERN.test(cached)) return cached;
  const made = await onAccount("POST", account, "/prices", tierPriceBody(store, product));
  const id = typeof made.id === "string" ? made.id : "";
  if (!PRICE_PATTERN.test(id)) throw new Error("Stripe returned no price");
  await redisPipeline([["SET", key, id, "EX", 400 * 86_400]]);
  return id;
}

/** The cached price of a tier dropped, when Stripe says it no longer has or sells it: the next use makes a new one. */
export async function forgetTierPrice(store: Store, product: Listing): Promise<void> {
  const account = store.stripeAccountId;
  if (!account) return;
  await redisPipeline([["DEL", priceKey(account, product, store.currency, taxMode(store))]]);
}

export type Preview = {
  sub: string;
  from: { id: string; title: string; words: string };
  to: { id: string; title: string; words: string };
  /** Charged now when above zero; taken off the next payments when below. */
  due: number;
  currency: string;
  trialing: boolean;
  /** The second the amount is worked out for; the switch uses the same one. */
  at: number;
  /** Whether the tier is handed over digitally at once: then the page asks the EU box again (91 [D2-EU-WITHDRAWAL]). */
  digital: boolean;
};

export type PreviewResult = { ok: true; preview: Preview } | { ok: false; reason: "expired" | "gone" | "tier" | "currency" | "freeDays" | "error" };

type Found = { grant: NonNullable<Awaited<ReturnType<typeof grantOf>>>; itemId: string; from: Listing; to: Listing; trialing: boolean };

/** Checks one switch against the link, the membership and the tiers, asking Stripe only what it must. */
async function find(store: Store, token: string, subscription: string, target: string): Promise<Found | { reason: "expired" | "gone" | "tier" | "currency" | "freeDays" }> {
  if (!SUB_PATTERN.test(subscription)) return { reason: "gone" };
  const grant = await grantOf(store, token);
  if (!grant) return { reason: "expired" };
  const sub = (await subsOf(store, grant)).find((s) => s.id === subscription);
  // Not this member's, not this store's, or no longer running: one answer for all.
  if (!sub || endsAtOf(sub) !== null || sub.metadata?.ends_after || !SWITCHABLE.has(String(sub.status))) return { reason: "gone" };
  // Paid, in free days: Stripe would prorate nothing, so nothing is switched until they end.
  if (inPaidFreeDays(sub as Record<string, unknown>)) return { reason: "freeDays" };
  const itemId = typeof sub.items?.data?.[0]?.id === "string" ? (sub.items.data[0].id as string) : "";
  if (!itemId || (sub.items?.data?.length ?? 0) !== 1) return { reason: "gone" };
  // The new tier's Price is made in the store's currency (tierPrice); a subscription
  // paid in another one (the store changed its currency since) is never moved onto it.
  if (subscriptionCurrency(sub, store.currency) !== store.currency) return { reason: "currency" };
  const tiers = await liveTiers(store);
  const from = tiers.find((t) => t.id === productOfSub(sub));
  const to = tiers.find((t) => t.id === target);
  if (!from || !to || from.id === to.id) return { reason: "tier" };
  return { grant, itemId, from, to, trialing: sub.status === "trialing" };
}

/** What a switch would cost right now, in Stripe's own figures. Changes nothing. */
export async function previewSwitch(store: Store, token: string, subscription: string, target: string): Promise<PreviewResult> {
  if (!isRedisConfigured() || !store.stripeAccountId) return { ok: false, reason: "error" };
  try {
    const found = await find(store, token, subscription, target);
    if ("reason" in found) return { ok: false, reason: found.reason };
    const price = await tierPrice(store, found.to);
    const at = Math.floor(Date.now() / 1000);
    const invoice = await onAccount("POST", found.grant.a, "/invoices/create_preview", previewBody(found.grant.c, subscription, found.itemId, price, at));
    // Read exactly first (previewKnown): an unknown preview is no figure, so no page shows an amount for it.
    if (!previewKnown(invoice)) {
      console.error("a tier switch's preview was not one this code knows", subscription);
      return { ok: false, reason: "error" };
    }
    // What the switch itself charges, not the whole next invoice (lib/tier-rules.ts).
    const due = dueNow(invoice as Parameters<typeof dueNow>[0], at);
    return {
      ok: true,
      preview: {
        sub: subscription,
        from: { id: found.from.id, title: found.from.title, words: tierWords(store, found.from, store.language) },
        to: { id: found.to.id, title: found.to.title, words: tierWords(store, found.to, store.language) },
        due: found.trialing ? 0 : due,
        currency: typeof invoice.currency === "string" ? invoice.currency : store.currency,
        trialing: found.trialing,
        at,
        digital: deliversDigitally(found.to),
      },
    };
  } catch (error) {
    if (!(error instanceof StripeError)) console.error("previewing a tier switch failed", error);
    return { ok: false, reason: "error" };
  }
}

export type SwitchResult =
  | { ok: true; title: string }
  | { ok: false; reason: "expired" | "gone" | "tier" | "currency" | "freeDays" | "stale" | "declined" | "busy" | "consent" | "unconfirmed" | "error" };

/**
 * Makes the switch, at the second the preview was worked out for. The card on
 * file pays the difference at once; if Stripe cannot take it, the change is
 * not made and the invoice is voided, so nothing is owed.
 *
 * A switch opens the new tier at once and charges at once, so it asks the
 * buyer's yes to that again, as every checkout does (91 [D2-EU-WITHDRAWAL];
 * the owner, C1-20261106-0100-TODOS-1): without a valid `consent` for a tier
 * handed over digitally, "consent", and nothing is sent to Stripe. The yes is
 * kept on the subscription in the request that charges (metadata[dc]), and
 * the receipt quotes it.
 */
export async function switchTier(store: Store, token: string, subscription: string, target: string, at: number, consent: DigitalConsent | null): Promise<SwitchResult> {
  if (!isRedisConfigured() || !store.stripeAccountId) return { ok: false, reason: "error" };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(at) || at > now + 60 || now - at > PREVIEW_SECONDS) return { ok: false, reason: "stale" };
  try {
    return await withLock(`nl:tier:${subscription}:lock`, 60, 5_000, async (): Promise<SwitchResult> => {
      const found = await find(store, token, subscription, target);
      if ("reason" in found) return { ok: false, reason: found.reason };
      const digital = deliversDigitally(found.to);
      if (digital && !validConsent(consent)) return { ok: false, reason: "consent" };
      const account = found.grant.a;
      const price = await tierPrice(store, found.to);
      const body = switchBody(found.itemId, price, at);
      const kept = digital && validConsent(consent) ? consentMetaValue(consent, consentKind(found.to)) : "";
      if (digital && validConsent(consent)) keepConsentOn(body, consent, consentKind(found.to));
      let updated: Record<string, unknown>;
      try {
        // Under the switch's stable key (switchKey): a retry of this preview is never a second charge.
        updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, body, SWITCH_STRIPE_VERSION, switchKey(subscription, at, price));
      } catch (error) {
        // Stripe answered a refusal (below 500): nothing was applied, said as before. No answer at all, Stripe's own
        // failure, or its answer that this key is still running or was used (refusedUnapplied), after the update was
        // sent: it may have been applied, so it is "unconfirmed", never "nothing changed" (Codex CX1 on #2764).
        // Nothing is sent again, and the lock is left to run out (keepWhileUnconfirmed).
        if (refusedUnapplied(error)) throw error;
        console.error("a tier switch's charging update had no answer that can be read", error);
        return { ok: false, reason: "unconfirmed" };
      }
      const answered = switchReply(updated, subscription, price, kept);
      if (answered === "unknown") {
        // Not known to be made: nothing more is written or sent, and the member is told it did not go through.
        // Not "error", whose words say nothing was changed: the card may have been charged (Revisor 2 on #2764).
        console.error("a tier switch's reply was not one this code knows", subscription);
        return { ok: false, reason: "unconfirmed" };
      }
      if (answered === "pending") {
        // Declined, or the bank asked for a step the member was not there to
        // take: nothing changed. The invoice left open is voided so nothing is owed.
        const invoice = updated.latest_invoice as { id?: unknown; status?: unknown } | null;
        if (invoice && typeof invoice.id === "string" && invoice.status === "open") {
          await onAccount("POST", account, `/invoices/${encodeURIComponent(invoice.id)}/void`, new URLSearchParams()).catch((error) =>
            console.error("voiding a declined tier switch failed", error),
          );
        }
        return { ok: false, reason: "declined" };
      }
      // The price already says the tier; the subscription's own record follows,
      // for Stripe's dashboard and for anything that reads it there.
      await onAccount(
        "POST",
        account,
        `/subscriptions/${encodeURIComponent(subscription)}`,
        new URLSearchParams({ "metadata[product]": found.to.id, "metadata[option]": "", "metadata[switched_from]": found.from.id }),
      ).catch((error) => console.error("recording a tier switch failed", error));
      await tell(store, account, found, updated, kept);
      return { ok: true, title: found.to.title };
    }, keepWhileUnconfirmed);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    if (!(error instanceof StripeError)) console.error("switching a tier failed", error);
    return { ok: false, reason: "error" };
  }
}

/** The member's receipt of the switch and the creator's note of it; and the doors asked again at once. */
async function tell(store: Store, account: string, found: Found, updated: Record<string, unknown>, kept: string): Promise<void> {
  let email = "";
  try {
    const customer = await onAccount("GET", account, `/customers/${encodeURIComponent(found.grant.c)}`);
    email = typeof customer.email === "string" ? customer.email : "";
  } catch (error) {
    console.error("reading a member's address failed", error);
  }
  if (!email) return;
  await Promise.all([forgetPaid(store, email), forgetTicket(store, email)]).catch(() => {});
  // What the card paid, after any credit the member already had; a credit when below zero. Read exactly: an invoice
  // that cannot be read says nothing about the amount (null), never that nothing was charged (Codex CX1 on #2764).
  const charged = found.trialing ? null : chargedOf(updated.latest_invoice);
  const total = charged?.cents ?? 0;
  const currency = charged?.currency ?? store.currency;
  // The member's receipt is in the store's language; the creator's note below stays in English.
  const m = membershipWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const paid =
    found.trialing
      ? m.paidTrial
      : !charged
        ? ""
        : total > 0
          ? m.paidCharged(formatMoney(total, currency, locale))
          : total < 0
            ? m.paidCredit(formatMoney(-total, currency, locale))
            : m.paidNothing;
  const from = `"${m.fromName(store.name.replace(/["\\<>\r\n]/g, "").slice(0, 60))}" <${(NIMBUS_FROM.match(/<([^>]+)>/)?.[1] ?? NIMBUS_FROM).trim()}>`;
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from,
    to: email,
    subject: m.switchedSubject(found.to.title).slice(0, 200),
    text: [
      m.switchedNow(store.name, found.to.title, found.from.title),
      "",
      ...(paid ? [paid] : []),
      m.fromNow(tierWords(store, found.to, store.language)),
      "",
      m.switchedOpen,
      // The yes given for this switch, quoted as a checkout's confirmation quotes it (the durable medium).
      ...consentEmailLines(store, kept ? { [CONSENT_META]: kept } : null),
      "",
      m.switchedFooter(store.name),
    ].join("\n"),
    replyTo: store.email,
  }).catch((error) => console.error("a tier switch receipt failed", error));
  if (store.email) {
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: NIMBUS_FROM,
      to: store.email,
      subject: `A member switched to ${found.to.title}`.slice(0, 200),
      text: [
        `${email} switched their membership from ${found.from.title} to ${found.to.title}.`,
        found.trialing ? "They are in their free trial; the new price starts when it ends." : !charged ? "The amount charged could not be read here; Stripe has it." : total > 0 ? `Charged today: ${formatMoney(total, currency)}.` : total < 0 ? `Credited to their next payments: ${formatMoney(-total, currency)}.` : "",
        "",
        "It is all on your own Stripe account, under that customer.",
      ].filter(Boolean).join("\n"),
    }).catch((error) => console.error("a tier switch note failed", error));
  }
}
