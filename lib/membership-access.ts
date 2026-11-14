/**
 * Membership access that ends when the membership does.
 *
 * A membership is paid for as it goes, so what it hands over — its file, its
 * course — is open while it is being paid for and closed once it is not.
 * Until this existed the thanks-page link of a membership kept its file open
 * for its three days whatever happened to the membership meanwhile. Now every
 * delivery a membership makes through Marktmorgen asks Stripe first:
 *
 *   - a download from the thanks page or the emailed list of purchases reads
 *     the checkout from the creator's own account on every request, as it
 *     always did, and now reads the membership's state in that same request;
 *   - a course page, lesson or lesson download reads it through lib/learn.ts,
 *     which keeps Stripe's answer for ten minutes;
 *   - anything else that only has the membership's id asks for it here, and
 *     the answer is kept for two minutes.
 *
 * Open means Stripe calls the membership active, in its free trial, or past
 * due while Stripe still has another attempt at its latest invoice scheduled
 * — the member's grace, not a reason to lock them out mid-retry. Anything
 * else — cancelled, unpaid after the retries, past due with no attempt left
 * (a creator's Stripe may leave it so), paused (by Stripe, or by a pause the
 * member chose, memberState), a first payment never made —
 * is ended, and the member is shown a page that says so plainly, with the
 * way to join again and, where a card can be fixed, the way to fix it.
 *
 * A membership that ends by itself after a set number of payments has ended
 * too, once the last period is over: that is what the creator sold.
 *
 * What this cannot reach is a link to somewhere else. A product delivered as
 * a link to a Google Drive folder, a Notion page or a private video is on
 * somebody else's server; once the member has the address they have it, and
 * only the creator can take it back there. The studio says so beside that
 * choice.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError } from "@/lib/redis-reply";
import { onAccount } from "@/lib/stripe-account";
import type { Listing, Store } from "@/lib/store";
import { type PauseSub, pausedNow } from "@/lib/membership-pause-rules";

/** The states in which a membership still hands over what it sells. */
export const LIVE_STATES = new Set(["active", "trialing", "past_due"]);

/** How long an answer read here is reused. */
export const STATUS_SECONDS = 2 * 60;

const SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9]{6,200}$/;
const statusKey = (account: string, subscription: string) => `nl:member:status:${account}:${subscription}`;

export function isLive(status: unknown): boolean {
  return typeof status === "string" && LIVE_STATES.has(status);
}

/**
 * What the doors call a membership that is past due with no attempt at its
 * latest invoice scheduled, or whose latest invoice was not read: ended.
 */
export const PAST_DUE_NO_RETRY = "past_due_no_retry";

/**
 * Whether Stripe has another attempt at a past-due membership's latest
 * invoice scheduled. The subscription carries no retry date of its own; its
 * latest invoice does (`next_payment_attempt`, null once none is scheduled),
 * so every door reads the membership with that invoice expanded. An invoice
 * not expanded, or any other shape, is not a retry.
 */
function retryScheduled(sub: object): boolean {
  const invoice = (sub as { latest_invoice?: unknown }).latest_invoice;
  if (!invoice || typeof invoice !== "object" || Array.isArray(invoice)) return false;
  const next = (invoice as { next_payment_attempt?: unknown }).next_payment_attempt;
  return typeof next === "number" && Number.isSafeInteger(next) && next > 0;
}

/**
 * The state a membership's doors go by: Stripe's own, or "paused" while a
 * pause its member chose is running (lib/membership-pause-rules.ts). Stripe
 * keeps calling a paused membership active, because it is not cancelled;
 * here it is not being paid for, so it opens nothing until the pause ends.
 * Past due is Stripe's own only while a retry is scheduled (PAST_DUE_NO_RETRY).
 */
export function memberState(sub: unknown): string | null {
  if (!sub || typeof sub !== "object") return null;
  const status = (sub as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  if (pausedNow(sub as PauseSub)) return "paused";
  return status === "past_due" && !retryScheduled(sub) ? PAST_DUE_NO_RETRY : status;
}

/** Whether a membership, as Stripe sent it, opens its doors now. */
export function isLiveSub(sub: unknown): boolean {
  return isLive(memberState(sub));
}

/**
 * Whether a checkout sold a membership, as opposed to a single sale or a
 * payment plan. A plan is also a subscription, but it pays for something
 * already handed over and ends by itself; it never closes anything.
 */
export function soldAMembership(product: Listing, session: { mode?: unknown; metadata?: Record<string, string> | null }): boolean {
  return product.recurring !== null && session.mode === "subscription" && session.metadata?.kind !== "plan";
}

/**
 * Stripe's state for a membership, from the subscription on a checkout —
 * already expanded, or asked for by its id and kept for two minutes. Null
 * only when the input is not a membership reference. Evidence read in an
 * unknown shape throws, so callers report a temporary error rather than an
 * ended membership or a renewal invitation. Its one
 * caller (lib/store-checkout.ts, readOrder) hands it the subscription with
 * its latest invoice expanded; read by its id alone, without that invoice, a
 * past-due membership is ended by the same rule (memberState).
 */
export async function membershipStatus(store: Store, subscription: unknown): Promise<string | null> {
  if (subscription && typeof subscription === "object") {
    if (Array.isArray(subscription)) throw new UnknownReplyError("an expanded membership");
    // An expanded status only proves access when its own data identity is
    // a subscription id. Do not read inherited or accessor identities.
    const id = Object.getOwnPropertyDescriptor(subscription, "id");
    if (!id || !("value" in id) || typeof id.value !== "string" || !SUBSCRIPTION_PATTERN.test(id.value)) throw new UnknownReplyError("an expanded membership");
    return memberState(subscription);
  }
  const account = store.stripeAccountId;
  if (typeof subscription !== "string" || !SUBSCRIPTION_PATTERN.test(subscription) || !account) return null;
  if (isRedisConfigured()) {
    const reply = await redisPipeline([["GET", statusKey(account, subscription)]]);
    if (!Array.isArray(reply) || reply.length !== 1 || !Object.hasOwn(reply, 0)) throw new UnknownReplyError("a membership status cache");
    const [cached] = reply;
    if (typeof cached === "string" && cached) return cached;
    // Only an explicit missing key permits the provider lookup. A partial
    // read does not prove either a live membership or an absent cache.
    if (cached !== null) throw new UnknownReplyError("a membership status cache value");
  }
  const sub = await onAccount("GET", account, `/subscriptions/${encodeURIComponent(subscription)}`);
  // A status from a different or unidentified subscription cannot authorize
  // access or populate the cache for the subscription that was requested.
  if (!sub || !Object.hasOwn(sub, "id") || sub.id !== subscription) throw new UnknownReplyError("a membership provider identity");
  const status = memberState(sub);
  if (status && isRedisConfigured()) {
    await redisPipeline([["SET", statusKey(account, subscription), status, "EX", STATUS_SECONDS]]);
  }
  return status;
}

/** Forgets what was kept of a membership's state, after it was changed here (lib/membership-pause.ts). */
export async function forgetStatus(account: string, subscription: string): Promise<void> {
  if (!isRedisConfigured() || !SUBSCRIPTION_PATTERN.test(subscription)) return;
  await redisPipeline([["DEL", statusKey(account, subscription)]]);
}

/** The page that tells a member their membership ended, and how to renew. */
export function renewPath(store: Store, product: Pick<Listing, "id">): string {
  return `/@${store.handle}/renew/${product.id}`;
}
