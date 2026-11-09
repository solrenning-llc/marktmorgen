/**
 * The yearly plan, offered once, at the moment a store first sells.
 *
 * Why then (11 October 2026). The store this one is first compared with,
 * Stan, loses about 13% of its creators every month (Contrary, August 2026):
 * a creator stays seven months on average. A creator on a yearly plan cannot
 * drift off in month three, and a creator who has just been paid by a
 * stranger is the one most sure the store is worth keeping. Asking before
 * that is asking somebody to commit to a tool that has not yet done anything
 * for them; asking much later is asking after the doubt has set in.
 *
 * What it is, precisely:
 *
 *   - The first paid sale of a store is noted once (noteFirstSale), from the
 *     five-minute pass over every selling store's checkouts
 *     (lib/checkout-sweep.ts). A tip is not a sale, and neither is anything
 *     that charged nothing.
 *   - At that moment, a store on a monthly plan that is paid up or in its
 *     trial, not set to stop and with no change of plan waiting, is written
 *     to once: what was sold, and what the yearly plan saves. Never again for
 *     the same subscription, however many first sales it is later told of.
 *   - The studio shows the same offer open, instead of folded away, from then
 *     on (firstSaleAt), until the store pays yearly.
 *
 * The price is the one on the pricing page (lib/plan.ts): the saving is a
 * fact of the published prices, not a discount made for the occasion, so
 * there is nothing that ends, and the email says no more than that.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { isBillingConfigured, readSubscription } from "@/lib/billing";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { PLANS_ON_SALE } from "@/lib/opening";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_NAMES, PLAN_PRICES, type Tier, yearSaving } from "@/lib/plan";
import { type Store, saleHandles } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";

/** Kept for good: the day a store first sold does not change. */
export const firstSaleKey = (store: Pick<Store, "sid" | "handle">) => `nl:firstsale:${store.sid || `h:${store.handle}`}`;
/** One offer per subscription, ever. */
const offeredKey = (subscription: string) => `nl:yearly-offer:${subscription}`;

/** A checkout, with only what is read here. */
type Checkout = { created?: unknown; amount_total?: unknown; metadata?: Record<string, string> | null };

/** Whether a paid checkout is a sale: money for something, not a gift. */
export function isSale(row: Checkout): boolean {
  return row.metadata?.kind !== "tip" && typeof row.amount_total === "number" && row.amount_total > 0;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** The email, plain text. */
export function yearlyOfferEmail(input: { tier: Tier; trialing: boolean }): { subject: string; text: string } {
  const name = PLAN_NAMES[input.tier];
  const month = dollars(PLAN_PRICES[input.tier].month);
  const year = dollars(PLAN_PRICES[input.tier].year);
  const saving = dollars(yearSaving(input.tier));
  return {
    subject: "Your store just made its first sale",
    text: [
      "Hello,",
      "",
      "Your store just made its first sale. Somebody you have never met paid you for something you made.",
      "",
      `You are on ${name} at ${month} a month. If you plan to keep selling, paying yearly costs ${year} instead of twelve payments of ${month}: ${saving} less over the year, at the prices on our pricing page.`,
      "",
      input.trialing
        ? "You are still in your free trial, so nothing is charged now. If you switch, the yearly price is what you pay when the trial ends."
        : "If you switch, you pay the yearly price today, less what is left of the month you already paid for, and the year starts today.",
      "",
      `Switch in your studio, where your plan is: ${SITE_URL}/studio#billing`,
      "",
      "Every charge is covered by our 30-day refund, the yearly one too. This is the only time we will write to you about it.",
      "",
      `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/** When the store first sold, in seconds, or 0 when it has not, or nothing is kept to say. */
export async function firstSaleAt(store: Pick<Store, "sid" | "handle">): Promise<number> {
  if (!isRedisConfigured()) return 0;
  try {
    const [raw] = await redisPipeline([["GET", firstSaleKey(store)]]);
    // The seconds, then (since Claude 5 on #2722) a point and a random part only this claim writes (noteFirstSale).
    const at = Math.floor(Number(raw));
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * Notes the first sale among a store's paid checkouts, if it is the first
 * ever seen, and makes the yearly offer. Safe to call with the same rows on
 * every pass: only the first call that finds a sale does anything.
 */
export async function noteFirstSale(store: Store, paid: Checkout[], plansOnSale = PLANS_ON_SALE): Promise<boolean> {
  if (!isRedisConfigured() || !store.stripeAccountId) return false;
  const sales = paid.filter(isSale);
  if (!sales.length) return false;
  // Asked of Redis first, so a store that has sold before costs one read a pass.
  // Read exactly (CX-123 rule 24, L9): only an exact 0 goes on; 1 or an unknown answer stops here this pass.
  const known = repliesFor(await redisPipeline([["EXISTS", firstSaleKey(store)]]), 1);
  if (!known || countOf(known[0]) !== 0) return false;
  const at = Math.min(...sales.map((row) => (typeof row.created === "number" && row.created > 0 ? row.created : Math.floor(Date.now() / 1000))));
  // The pass only sees the last day. A store that sold before this was built
  // is not making its first sale today, and must not be told it is: its own
  // Stripe account is asked once for anything paid earlier.
  const earlier = await soldBefore(store, at);
  if (earlier === null) return false; // Stripe could not be asked: the next pass asks again.
  // The first sale's day is noted once, for good: ours only on OK or our own value read back. The value is the day in
  // seconds and a random part (claimValue), so no other run writes it, and firstSaleAt still reads the day.
  const value = claimValue(earlier || at);
  const noted = await claimMark(firstSaleKey(store), null, value);
  if (noted === "unknown") {
    // It may have landed, and kept for good it would stop every later pass at its EXISTS before the offer is made
    // (Claude 5 on #2722). Nothing was sent on it, so it is let go if it is ours, and the next pass notes it again.
    await releaseMark(firstSaleKey(store), value);
    return false;
  }
  if (noted !== "ours" || earlier) return false;
  const offered = await offerOnce(store, plansOnSale).catch((error) => {
    console.error("offering the yearly plan failed", store.handle, error);
    return "no" as const;
  });
  if (offered === "unknown") {
    // The once-per-subscription mark was not known, so nothing was sent and offerOnce let it go: the first sale is
    // let go too, so the next pass makes the offer again, once (offeredKey still keeps it to one).
    await releaseMark(firstSaleKey(store), value);
    return false;
  }
  return true;
}

/**
 * When the store was first paid for something before `at`, in seconds: 0 when
 * never, null when its Stripe account could not be asked. Stripe lists newest
 * first, so the oldest of the page read is written down; for a store with
 * more than a page of earlier sales that is a later day than the first, which
 * is still a day before this one, and all the answer has to tell is that.
 */
async function soldBefore(store: Store, at: number): Promise<number | null> {
  const handles = saleHandles(store);
  try {
    const listed = await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions?limit=100&status=complete&created[lt]=${at}`,
    );
    const rows = (Array.isArray(listed.data) ? listed.data : []) as (Checkout & { payment_status?: unknown })[];
    const sold = rows.filter((row) => row.payment_status === "paid" && isSale(row) && handles.has(row.metadata?.store ?? ""));
    if (!sold.length) return 0;
    return Math.min(...sold.map((row) => (typeof row.created === "number" ? row.created : at)));
  } catch (error) {
    console.error("asking a store's Stripe account about earlier sales failed", store.handle, error);
    return null;
  }
}

/** Writes the offer, once per subscription, to a store it fits. */
export async function offerYearly(store: Store, plansOnSale = PLANS_ON_SALE): Promise<boolean> {
  return (await offerOnce(store, plansOnSale)) === "sent";
}

/**
 * offerYearly, saying why nothing was sent: "unknown" when the once-per-subscription mark could not be known
 * (nothing was sent, and the mark, if it landed, was let go), "no" for every other reason.
 */
async function offerOnce(store: Store, plansOnSale: boolean): Promise<"sent" | "no" | "unknown"> {
  const subscription = store.subscriptionId;
  // While no plan is on sale the studio cannot switch one (app/api/billing/switch), so nothing is offered.
  if (!plansOnSale || !subscription || !isBillingConfigured() || !isSenderConfigured() || !store.email) return "no";
  // Every plan is checked out with contract funding, which reads as "unknown" without the store; this only decides an
  // email, so its proof is read in mode "observe": confirmed when already committed, never activated or written.
  const live = await readSubscription(subscription, store, "observe");
  if (live.state !== "active" || live.cycle !== "month" || live.cancelsAtEnd || live.changePending) return "no";
  // Once per subscription, for good: ours only on OK or our own value read back (CX-123 rule 24, L9).
  const offer = claimValue();
  const claimed = await claimMark(offeredKey(subscription), null, offer);
  if (claimed === "unknown") {
    // It may have landed, and kept for good it would stop every later offer (Claude 5 on #2722). Nothing was sent on
    // it, so it is let go if it still holds our own value (never another run's), and a later pass tries again.
    await releaseMark(offeredKey(subscription), offer);
    return "unknown";
  }
  if (claimed !== "ours") return "no";
  const { subject, text } = yearlyOfferEmail({ tier: live.tier, trialing: live.trialing });
  const ok = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: store.email, subject, text, replyTo: SUPPORT_EMAIL });
  if (!ok) {
    // Not sent is not offered: the next store pass cannot try again, because
    // the first sale is already noted, so the mark is taken back and the
    // studio keeps showing the offer open, which is the half that matters.
    await releaseMark(offeredKey(subscription), offer);
  }
  return ok ? "sent" : "no";
}
