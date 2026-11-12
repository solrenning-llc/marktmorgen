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
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
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
  // The day's email is ours only on an exact claim (lib/claim-mark.ts), and a failed send lets go of our own
  // mark only: one that ran out and was taken by another run stays.
  const mark = claimValue(now);
  if ((await claimMark(mailKey(store.statsId, day), 2 * 86_400, mark)) !== "ours") return "counted";
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
  if (!sent) await releaseMark(mailKey(store.statsId, day), mark);
  return sent ? "emailed" : "counted";
}

/** The refusals of the last 7 days and the last one kept, for the studio. */
export async function readTrouble(statsId: string | null, now = Date.now()): Promise<Trouble> {
  if (!statsId || !isRedisConfigured()) return { week: 0, last: null };
  return readWeek(statsId, now);
}

/**
 * The same, read strictly for the studio's checkup (491 [PP2]): null when the
 * refusals could not be read, or were never counted (no store stats id, no
 * Redis), so "Stripe opened every checkout" is said only from a real count.
 */
export async function readTroubleStrict(statsId: string | null, now = Date.now()): Promise<Trouble | null> {
  if (!statsId || !isRedisConfigured()) return null;
  try {
    return await readWeek(statsId, now);
  } catch {
    return null;
  }
}

/** One fixed read: old day fields cannot enlarge the database transfer. The
 * writer renews the whole hash's TTL, so that TTL is not a per-field bound.
 * This bounds the reader only; it does not fund that historical storage.
 */
async function readWeek(statsId: string, now: number): Promise<Trouble> {
  const days = Array.from({ length: 7 }, (_, back) => new Date(now - back * 86_400_000).toISOString().slice(0, 10));
  const reply: unknown = await redisPipeline([["HMGET", key(statsId), ...days, "last"]]);
  if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0]) || reply[0].length !== 8) throw new Error("Checkout refusals unavailable");
  const values: unknown[] = reply[0];
  let week = 0;
  let last: Trouble["last"] = null;
  for (let i = 0; i < 7; i += 1) {
    const raw = values[i];
    if (raw === null) continue;
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) throw new Error("Checkout refusals unavailable");
    const count = Number(raw);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(week + count)) throw new Error("Checkout refusals unavailable");
    week += count;
  }
  const rawLast = values[7];
  if (rawLast !== null) {
    if (typeof rawLast !== "string") throw new Error("Checkout refusals unavailable");
    const value: unknown = JSON.parse(rawLast);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkout refusals unavailable");
    const entry = value as Record<string, unknown>;
    if (!Number.isSafeInteger(entry.at) || (entry.at as number) < 0 || typeof entry.code !== "string" || entry.code.length > 60 ||
        typeof entry.message !== "string" || entry.message.length > MESSAGE_LENGTH) throw new Error("Checkout refusals unavailable");
    last = { at: entry.at as number, code: entry.code, message: entry.message };
  }
  return { week, last: last && last.at >= now - 7 * 86_400_000 ? last : null };
}
