/**
 * When Stripe will not open a checkout (added 11 October 2026).
 *
 * A buyer presses buy, Stripe refuses to make the payment page — the account
 * needs something before it can take payments, a currency it cannot charge,
 * a price the creator archived in their own dashboard — and the buyer lands
 * back on the store with a sentence saying something went wrong. From the
 * creator's side nothing happened at all: no sale, no email, nothing in the
 * numbers. Crazy Egg sells error tracking, and Contentsquare and Mouseflow
 * sell friction monitoring, for this reason; here it is the one error that
 * costs a sale.
 *
 * Counted by the day, for 35 days, with the last refusal kept as Stripe
 * worded it. The creator is emailed the first time Stripe refuses on a day,
 * and at most once a day: only for a refusal Stripe made on purpose (an
 * answer from 400 to 499 other than "too many requests"), not for Stripe
 * being slow or down, which is Stripe's to fix and passes by itself. It goes
 * whether or not the numbers emails are stopped, because it is about the
 * store not taking money, not about its numbers. Nothing about the buyer is
 * kept.
 *
 *   nl:cotrouble:<statsId>              hash: <day> → refusals; "last" → JSON { at, code, message }
 *   nl:cotrouble:mail:<statsId>:<day>   the day's email, claimed (2 days)
 */
import { type Store } from "@/lib/store";
import { StripeError } from "@/lib/stripe-account";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";

const key = (statsId: string) => `nl:cotrouble:${statsId}`;
const mailKey = (statsId: string, day: string) => `nl:cotrouble:mail:${statsId}:${day}`;
const KEEP_SECONDS = 35 * 86_400;
const MESSAGE_LENGTH = 300;

/** Whether an error is Stripe refusing on purpose, which the creator can put right. */
export function isRefusal(error: unknown): error is StripeError {
  return error instanceof StripeError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

export type Trouble = {
  /** Refusals over the last 7 days. */
  week: number;
  /** The last one, as Stripe worded it; null with none kept. */
  last: { at: number; code: string; message: string } | null;
};

/** Counts a checkout Stripe would not open and, the first time on a day, tells the creator. */
export async function noteCheckoutTrouble(store: Store, error: unknown, now = Date.now()): Promise<"counted" | "emailed" | "skipped"> {
  if (!(error instanceof StripeError) || !store.statsId || !isRedisConfigured()) return "skipped";
  const day = new Date(now).toISOString().slice(0, 10);
  const message = (error.stripeMessage || "Stripe gave no reason.").replace(/\s+/g, " ").trim().slice(0, MESSAGE_LENGTH);
  await redisPipeline([
    ["HINCRBY", key(store.statsId), day, 1],
    ["HSET", key(store.statsId), "last", JSON.stringify({ at: now, code: error.code.slice(0, 60), message })],
    ["EXPIRE", key(store.statsId), KEEP_SECONDS],
  ]);
  if (!isRefusal(error) || !isSenderConfigured()) return "counted";
  const [claimed] = await redisPipeline([["SET", mailKey(store.statsId, day), "1", "NX", "EX", 2 * 86_400]]);
  if (claimed === null) return "counted";
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `${store.name}: Stripe would not open a checkout`.slice(0, 180),
    text: [
      `A buyer pressed buy on ${store.name} today and Stripe would not open the payment page, so they could not pay. Stripe's reason, in its own words:`,
      "",
      `  ${message}`,
      "",
      "What usually puts it right:",
      "- If it mentions your account, verification or charges: open your Stripe dashboard. Stripe often needs a detail or a document before it takes more payments, and says which at the top of the page.",
      "- If it mentions a price or a product: open the product in your studio and save it again, which makes its price afresh.",
      "- If it mentions a currency or a way to pay: check your store's currency in the studio against what your Stripe account can charge.",
      "",
      `How many times it happened is under Numbers in your studio: ${SITE_URL}/studio`,
      "",
      "This email comes at most once a day, and only on a day Stripe refuses.",
    ].join("\n"),
  }).catch(() => false);
  // Not sent: the day's claim is let go, so the next refusal tries again.
  if (!sent) await redisPipeline([["DEL", mailKey(store.statsId, day)]]).catch(() => undefined);
  return sent ? "emailed" : "counted";
}

/** The refusals of the last 7 days and the last one kept, for the studio. */
export async function readTrouble(statsId: string | null, now = Date.now()): Promise<Trouble> {
  if (!statsId || !isRedisConfigured()) return { week: 0, last: null };
  const [raw] = await redisPipeline([["HGETALL", key(statsId)]]);
  return troubleFrom(raw, now);
}

/**
 * The same, read strictly for the studio's checkup (491 [PP2]): null when the
 * refusals could not be read, or were never counted (no store stats id, no
 * Redis), so "Stripe opened every checkout" is said only from a real count.
 */
export async function readTroubleStrict(statsId: string | null, now = Date.now()): Promise<Trouble | null> {
  if (!statsId || !isRedisConfigured()) return null;
  try {
    const reply: unknown = await redisPipeline([["HGETALL", key(statsId)]]);
    if (!Array.isArray(reply) || reply.length !== 1) return null;
    const [raw] = reply as unknown[];
    if (raw !== null && !Array.isArray(raw)) return null;
    return troubleFrom(raw, now);
  } catch {
    return null;
  }
}

function troubleFrom(raw: unknown, now: number): Trouble {
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const since = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  let week = 0;
  let last: Trouble["last"] = null;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] === "last") {
      try {
        const value = JSON.parse(flat[i + 1]) as Record<string, unknown>;
        if (typeof value.at === "number" && typeof value.message === "string") {
          last = { at: value.at, code: typeof value.code === "string" ? value.code : "", message: value.message };
        }
      } catch {}
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(flat[i]) && flat[i] >= since) {
      week += Number(flat[i + 1]) || 0;
    }
  }
  return { week, last: last && last.at >= now - 7 * 86_400_000 ? last : null };
}
