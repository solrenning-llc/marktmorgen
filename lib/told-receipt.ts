import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";

/**
 * What a money route answered, kept a short while for the page it sends the creator to (#4399). An address such as
 * `?billing=canceling` or `?done=refunded` can be typed by anyone: the page says a cancel, a resume or a refund
 * happened only when the route that made it left the same answer for the same store here, at most TOLD_SECONDS ago.
 * One small key a store and topic, overwritten by the next answer, expiring by itself.
 */
export const TOLD_SECONDS = 600;
export type ToldTopic = "refund" | "billing";

const toldKey = (topic: ToldTopic, sid: string) => `nl:told:${topic}:${sid}`;

/** Leaves the route's answer for its page. Never in the way of the answer itself: a failed write only means the page says less. */
export async function tell(sid: string, topic: ToldTopic, value: string): Promise<void> {
  if (!sid || !isRedisConfigured()) return;
  await redisPipeline([["SET", toldKey(topic, sid), value, "EX", TOLD_SECONDS]]).catch(() => undefined);
}

/** Whether the route left exactly this answer for this store. An unknown reply is not a yes. */
export async function wasTold(sid: string, topic: ToldTopic, value: string): Promise<boolean> {
  if (!sid || !isRedisConfigured()) return false;
  const reply: unknown = await redisPipeline([["GET", toldKey(topic, sid)]]).catch(() => null);
  return Array.isArray(reply) && reply.length === 1 && reply[0] === value;
}

/** The refund page's answers that say money moved and end the offer. */
export const REFUND_CONFIRMS = new Set(["refunded", "ending"]);
/** The billing answers that say the subscription changed. */
const BILLING_CONFIRMS = new Set(["canceling", "resumed"]);

/**
 * Whether the studio may show the notice an address asks for. "Ready" holds only as the store's own record says
 * (the Stripe and PayPal routes write it before they redirect); a cancel or a resume only as the billing route
 * told this store. Any other notice confirms nothing and is shown as it always was.
 */
export async function urlNoticeHolds(kind: "stripe" | "paypal" | "billing", value: string, store: Store | null): Promise<boolean> {
  if (kind === "stripe" && value === "ready") return Boolean(store?.stripeAccountId && store.stripeChargesEnabled);
  if (kind === "paypal" && value === "ready") return Boolean(store?.paypalSeller);
  if (kind === "billing" && BILLING_CONFIRMS.has(value)) return store ? wasTold(store.sid, "billing", value) : false;
  return true;
}
