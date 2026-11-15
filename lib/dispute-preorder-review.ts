/**
 * Read one retained pre-order row after a server-verified Stripe binding.
 * No receipt reconstruction, token, buyer-thread scan, TTL refresh or write.
 */
import type { Store } from "@/lib/store";
import { CHECKOUT_SESSION_ID, type StripePurchaseBinding } from "@/lib/dispute-purchase-binding";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { takeAllowance } from "@/lib/store-allowance";

export type RetainedPreorderReview =
 | { status: "missing" | "unavailable" }
 | { status: "available"; checkoutCreatedAt: number; grantedAt: number | null; revokedAt: number | null; lookupStartedAt: number; retainedUntil: number };
const MAX_TTL_MS = 400 * 86_400_000;
/** HGET and PTTL atomically, with at most 1024 bytes returned. Read commands only. */
export const PREORDER_REVIEW_READ = 'local v=redis.call("HGET",KEYS[1],ARGV[1]);local t=redis.call("PTTL",KEYS[1]);if not v then return {0,"",t} end;if string.len(v)>1024 then return {2,"",t} end;return {1,v,t}';
function whole(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
function object(v: unknown): Record<string, unknown> | null { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }

/** The caller must authorize the store and obtain binding on its actual account. */
export async function readRetainedPreorderReview(store: Store, binding: StripePurchaseBinding, nowMs = Date.now()): Promise<RetainedPreorderReview> {
 const unavailable = { status: "unavailable" } as const;
 if (!binding || store.stripeAccountId !== binding.account || !store.sid ||
  !store.statsId || !/^[A-Za-z0-9_-]{1,128}$/.test(store.statsId) ||
  !CHECKOUT_SESSION_ID.test(binding.purchase) || !/^[a-f0-9]{32}$/.test(binding.product) ||
  !whole(nowMs) || !isRedisConfigured()) return unavailable;
 try {
  if (!(await reservePaidResourceWindow({ ...store, statsId: store.statsId, tier: store.tier ?? "creator" }))) return unavailable;
  if (!(await takeAllowance(store, "integration")).ok) return unavailable;
  // Never derive a key, product, account or purchase from request-body choices.
  const [reply] = await redisPipeline([["EVAL", PREORDER_REVIEW_READ, 1, "nl:pre:" + store.statsId + ":" + binding.product, binding.purchase]]);
  if (!Array.isArray(reply) || reply.length !== 3) return unavailable;
  const [state, raw, ttl] = reply;
  if (state === 0 && raw === "") return { status: "missing" };
  if (state !== 1 || typeof raw !== "string" || raw.length > 1024 ||
   !whole(ttl) || ttl < 1 || ttl > MAX_TTL_MS) return unavailable;
  const row = object(JSON.parse(raw));
  const now = Math.floor(nowMs / 1000);
  if (!row || row.to !== binding.buyerEmail || row.pi !== binding.paymentIntent ||
   row.at !== binding.checkoutCreatedAt || !whole(row.at) || row.at > now) return unavailable;
  for (const key of ["given", "revoked"]) {
   if (row[key] !== undefined && (!whole(row[key]) || (row[key] as number) < binding.chargeCreatedAt || (row[key] as number) > now)) return unavailable;
  }
  // 'given' follows access-grant persistence but precedes email sending.
  // Its presence is not proof of email delivery, downloading or attendance.
  return { status: "available", checkoutCreatedAt: row.at,
   grantedAt: typeof row.given === "number" ? row.given : null,
   revokedAt: typeof row.revoked === "number" ? row.revoked : null,
   lookupStartedAt: now, retainedUntil: Math.floor((nowMs + ttl) / 1000) };
 } catch { return unavailable; }
}
