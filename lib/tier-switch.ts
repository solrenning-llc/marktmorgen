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
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { readListings } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { type Membership, endsAtOf, grantOf, subscriptionCurrency, subsOf } from "@/lib/membership-manage";
import { canTier, direction, dueNow, productOfSub } from "@/lib/tier-rules";
import { formatMoney } from "@/lib/money";
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
};

export type PreviewResult = { ok: true; preview: Preview } | { ok: false; reason: "expired" | "gone" | "tier" | "currency" | "error" };

type Found = { grant: NonNullable<Awaited<ReturnType<typeof grantOf>>>; itemId: string; from: Listing; to: Listing; trialing: boolean };

/** Checks one switch against the link, the membership and the tiers, asking Stripe only what it must. */
async function find(store: Store, token: string, subscription: string, target: string): Promise<Found | { reason: "expired" | "gone" | "tier" | "currency" }> {
  if (!SUB_PATTERN.test(subscription)) return { reason: "gone" };
  const grant = await grantOf(store, token);
  if (!grant) return { reason: "expired" };
  const sub = (await subsOf(store, grant)).find((s) => s.id === subscription);
  // Not this member's, not this store's, or no longer running: one answer for all.
  if (!sub || endsAtOf(sub) !== null || sub.metadata?.ends_after || !SWITCHABLE.has(String(sub.status))) return { reason: "gone" };
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
      },
    };
  } catch (error) {
    if (!(error instanceof StripeError)) console.error("previewing a tier switch failed", error);
    return { ok: false, reason: "error" };
  }
}

export type SwitchResult =
  | { ok: true; title: string }
  | { ok: false; reason: "expired" | "gone" | "tier" | "currency" | "stale" | "declined" | "busy" | "error" };

/**
 * Makes the switch, at the second the preview was worked out for. The card on
 * file pays the difference at once; if Stripe cannot take it, the change is
 * not made and the invoice is voided, so nothing is owed.
 */
export async function switchTier(store: Store, token: string, subscription: string, target: string, at: number): Promise<SwitchResult> {
  if (!isRedisConfigured() || !store.stripeAccountId) return { ok: false, reason: "error" };
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(at) || at > now + 60 || now - at > PREVIEW_SECONDS) return { ok: false, reason: "stale" };
  try {
    return await withLock(`nl:tier:${subscription}:lock`, 60, 5_000, async (): Promise<SwitchResult> => {
      const found = await find(store, token, subscription, target);
      if ("reason" in found) return { ok: false, reason: found.reason };
      const account = found.grant.a;
      const price = await tierPrice(store, found.to);
      const updated = await onAccount("POST", account, `/subscriptions/${encodeURIComponent(subscription)}`, switchBody(found.itemId, price, at));
      if (updated.pending_update) {
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
      await tell(store, account, found, updated);
      return { ok: true, title: found.to.title };
    });
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    if (!(error instanceof StripeError)) console.error("switching a tier failed", error);
    return { ok: false, reason: "error" };
  }
}

/** The member's receipt of the switch and the creator's note of it; and the doors asked again at once. */
async function tell(store: Store, account: string, found: Found, updated: Record<string, unknown>): Promise<void> {
  let email = "";
  try {
    const customer = await onAccount("GET", account, `/customers/${encodeURIComponent(found.grant.c)}`);
    email = typeof customer.email === "string" ? customer.email : "";
  } catch (error) {
    console.error("reading a member's address failed", error);
  }
  if (!email) return;
  await Promise.all([forgetPaid(store, email), forgetTicket(store, email)]).catch(() => {});
  const invoice = updated.latest_invoice as { total?: unknown; amount_paid?: unknown; currency?: unknown } | null;
  // What the card paid, after any credit the member already had; a credit when below zero.
  const raw = typeof invoice?.total === "number" && !found.trialing ? invoice.total : 0;
  const total = raw > 0 && typeof invoice?.amount_paid === "number" ? invoice.amount_paid : raw;
  const currency = typeof invoice?.currency === "string" ? invoice.currency : store.currency;
  // The member's receipt is in the store's language; the creator's note below stays in English.
  const m = membershipWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const paid =
    found.trialing
      ? m.paidTrial
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
      paid,
      m.fromNow(tierWords(store, found.to, store.language)),
      "",
      m.switchedOpen,
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
        found.trialing ? "They are in their free trial; the new price starts when it ends." : total > 0 ? `Charged today: ${formatMoney(total, currency)}.` : total < 0 ? `Credited to their next payments: ${formatMoney(-total, currency)}.` : "",
        "",
        "It is all on your own Stripe account, under that customer.",
      ].filter(Boolean).join("\n"),
    }).catch((error) => console.error("a tier switch note failed", error));
  }
}
