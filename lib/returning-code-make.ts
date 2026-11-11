/**
 * Making and stopping a code only for people who already bought from this
 * store, from the studio (554 [DS1], unit 2; lib/returning-code-rules.ts).
 *
 * Making one is one coupon on the creator's own Stripe account (what it
 * takes off, once, and at most so many uses: Stripe's own rules, checked by
 * Stripe when the coupon is applied), then the word kept on the store. Never
 * a promotion code, so Stripe's own code box can never take it. The word
 * must not be one of the creator's live promotion codes either, so a buyer
 * never meets two codes with one word.
 *
 * Stopping one takes the word off the store first, which is what stops it
 * (the checkout finds codes only there), then deletes the coupon on Stripe:
 * a coupon left behind takes nothing off anybody, because nothing points at
 * it, and a past order that used it keeps its history.
 *
 * Nothing here is read as done unless Stripe's answer says so exactly.
 */
import { onAccount, StripeError } from "@/lib/stripe-account";
import { CODES_API_VERSION } from "@/lib/discount";
import type { CodeAsked } from "@/lib/discount-input";
import { MAX_RETURNING_CODES, type ReturningCode } from "@/lib/returning-code-rules";
import { type Store, addReturningCode, removeReturningCode } from "@/lib/store";

export type MadeReturning = { ok: true; code: ReturningCode } | { ok: false; reason: "taken" | "full" | "minimum" | "stripe" };

/** Whether the creator has a live promotion code with this word: true, false, or null when Stripe's answer is not a list. */
async function livePromotionWord(account: string, word: string): Promise<boolean | null> {
  try {
    const page = await onAccount("GET", account, `/promotion_codes?limit=1&active=true&code=${encodeURIComponent(word)}`, undefined, CODES_API_VERSION);
    if (!page || typeof page !== "object" || !Array.isArray(page.data)) return null;
    return page.data.length > 0;
  } catch {
    return null;
  }
}

/** The coupon Stripe made, read exactly: its id, and what it takes off as asked. */
function madeCoupon(row: Record<string, unknown>, asked: CodeAsked): string | null {
  if (typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id)) return null;
  if (row.duration !== "once") return null;
  const off = asked.off;
  if (off.kind === "percent" ? row.percent_off !== off.percent : row.amount_off !== off.cents || row.currency !== off.currency) return null;
  if (row.max_redemptions !== (asked.maxRedemptions ?? null)) return null;
  return row.id;
}

export async function makeReturningCode(email: string, store: Store, asked: CodeAsked, now = Date.now()): Promise<MadeReturning> {
  const account = store.stripeAccountId;
  if (!account) return { ok: false, reason: "stripe" };
  // A coupon applied by us has no minimum Stripe would check: refused, never dropped.
  if (asked.minimum) return { ok: false, reason: "minimum" };
  if (store.returningCodes.some((entry) => entry.code === asked.code)) return { ok: false, reason: "taken" };
  if (store.returningCodes.length >= MAX_RETURNING_CODES) return { ok: false, reason: "full" };
  // Read strictly: a list that cannot be read is not "no such code".
  const live = await livePromotionWord(account, asked.code);
  if (live === null) return { ok: false, reason: "stripe" };
  if (live) return { ok: false, reason: "taken" };
  const coupon = new URLSearchParams({ duration: "once", name: asked.code, "metadata[returning]": asked.code });
  if (asked.off.kind === "percent") coupon.set("percent_off", String(asked.off.percent));
  else {
    coupon.set("amount_off", String(asked.off.cents));
    coupon.set("currency", asked.off.currency);
  }
  if (asked.maxRedemptions !== null) coupon.set("max_redemptions", String(asked.maxRedemptions));
  let id: string | null = null;
  try {
    id = madeCoupon(await onAccount("POST", account, "/coupons", coupon, CODES_API_VERSION), asked);
  } catch (error) {
    console.error("making a returning-buyer coupon failed", error instanceof StripeError ? error.message : error);
    return { ok: false, reason: "stripe" };
  }
  if (!id) return { ok: false, reason: "stripe" };
  const entry: ReturningCode = { code: asked.code, coupon: id, off: asked.off, endsAt: null, createdAt: Math.floor(now / 1000) };
  const kept = await addReturningCode(email, entry);
  if (kept !== "ok") {
    // Not kept: the coupon takes nothing off anybody, nothing points at it. Deleted so it does not linger.
    await onAccount("DELETE", account, `/coupons/${encodeURIComponent(id)}`, undefined, CODES_API_VERSION).catch(() => null);
    return { ok: false, reason: kept === "taken" ? "taken" : kept === "full" ? "full" : "stripe" };
  }
  return { ok: true, code: entry };
}

/** Takes the code off the store (which stops it), then deletes its coupon. True once the store no longer has it. */
export async function stopReturningCode(email: string, store: Store, word: string): Promise<boolean> {
  const entry = store.returningCodes.find((c) => c.code === word);
  if (!entry) return false;
  if (!(await removeReturningCode(email, word))) return false;
  if (store.stripeAccountId) {
    await onAccount("DELETE", store.stripeAccountId, `/coupons/${encodeURIComponent(entry.coupon)}`, undefined, CODES_API_VERSION).catch((error) => {
      console.error("deleting a stopped returning-buyer coupon failed; nothing points at it", error);
      return null;
    });
  }
  return true;
}
