/**
 * "Where did you hear about us?" (added 11 October 2026): one question on the
 * page a buyer lands on after paying, answered with a tap or not at all.
 *
 * What it is for. Every count in the studio sees a click: a link, a site, an
 * app. None of them sees a friend who said "you should buy this", a voice
 * note, a podcast, a group chat — what marketers call dark social, and for a
 * creator often the biggest channel there is. The only way to know is to ask
 * the buyer, which is what Hotjar's and PostHog's surveys are bought for. So
 * the store asks, once, after the money has been paid and nothing depends on
 * the answer.
 *
 * What is kept: a count of each answer, and the money of the sales it was
 * given for, on the day's record of the store's numbers — not the buyer, not
 * the order, not the time. The order is looked up once, to check it is a
 * paid order of this store, and marked answered so it is counted once.
 *
 * A creator who would rather not ask switches it off; it is on otherwise,
 * because it costs the buyer one tap they can skip.
 *
 *   nl:heard:off              set of store handles that do not ask
 *   nl:heard:done:<session>   an order whose answer was counted (30 days)
 *   day record h:<answer>     answers; hc:<answer> the money of their sales
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { countHeard, saleChannel } from "@/lib/stats";
import { isHeardAnswer } from "@/lib/heard-rules";

const OFF = "nl:heard:off";
const doneKey = (session: string) => `nl:heard:done:${session}`;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/** An order is asked about on the page the buyer lands on; a month later it is not answered. */
const ANSWER_WITHIN_SECONDS = 30 * 86400;

export async function heardOff(handle: string): Promise<boolean> {
  if (!isRedisConfigured()) return true;
  const [member] = await redisPipeline([["SISMEMBER", OFF, handle]]);
  return Number(member) === 1;
}

export async function setHeardOff(handle: string, off: boolean): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline([[off ? "SADD" : "SREM", OFF, handle]]);
}

export type HeardResult = "counted" | "already" | "invalid" | "off" | "unavailable";

/**
 * Counts one buyer's answer, for an order of this store that was paid in the
 * last 30 days and has not been answered for yet.
 */
export async function recordHeard(store: Store, sessionId: unknown, answer: unknown, now = Date.now()): Promise<HeardResult> {
  if (!isHeardAnswer(answer) || typeof sessionId !== "string" || !SESSION.test(sessionId)) return "invalid";
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return "unavailable";
  if (await heardOff(store.handle)) return "off";
  let session: Record<string, unknown>;
  try {
    session = (await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(sessionId)}`)) as Record<string, unknown>;
  } catch {
    return "invalid";
  }
  const meta = (session.metadata ?? {}) as Record<string, string>;
  const created = typeof session.created === "number" ? session.created : 0;
  const paid = session.status === "complete" && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  if (!paid || !saleHandles(store).has(meta.store ?? "") || created < now / 1000 - ANSWER_WITHIN_SECONDS) return "invalid";
  // Read exactly (CX-123 rule 24): counted only on a mark that is ours; one that cannot be read is not counted now.
  const mine = claimValue();
  const claimed = await claimMark(doneKey(sessionId), ANSWER_WITHIN_SECONDS, mine);
  if (claimed === "taken") return "already";
  if (claimed === "unknown") {
    // A mark this run may have written is let go only while it holds this run's value, so the next try counts it
    // (Claude 3 on #2723); another's is never touched.
    await releaseMark(doneKey(sessionId), mine);
    return "unavailable";
  }
  const currency = typeof session.currency === "string" ? session.currency.toLowerCase() : "";
  const cents = currency === store.currency && typeof session.amount_total === "number" ? session.amount_total : 0;
  // With no channel on the sale, the answer is the only trace of where it came from (lib/attribution-rules.ts).
  await countHeard(store.statsId, answer, cents, now, !saleChannel(meta).source);
  return "counted";
}
