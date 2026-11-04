/**
 * Whether a call can still be booked (moved here from
 * components/store-product.tsx on 4 November 2026, so the server can ask it
 * outside a page, as an email's product card does). The page re-exports it
 * unchanged.
 */
import type { CallSetup } from "@/lib/call-setup";

/** Whether a call can still be booked: always for weekly hours, and for dated sessions while one is before its notice. */
export function hasDateOnSale(call: CallSetup, now = Date.now()): boolean {
  if (call.kind !== "live") return true;
  return call.sessions.some((s) => s.start - call.noticeHours * 3600_000 > now);
}
