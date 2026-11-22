import type { NextRequest } from "next/server";
import { setCallPackage, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { heldRefusal } from "@/lib/child-safety";
import { priceInRange, readMoney } from "@/lib/money";
import { MAX_PACKAGE_SESSIONS, MIN_PACKAGE_SESSIONS, PACKAGE_DAYS } from "@/lib/call-package-rules";

/**
 * Sets a weekly call's package — `{ id, sessions, price, days }` — or takes
 * it off (`{ id, sessions: 0 }`). Bookings already made from packages keep
 * their sessions either way.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const fail = (error: string) => Response.json({ ok: false, error }, { status: 400 });
  const store = await storeForEmail(ref);
  if (!store) return fail("none");
  const id = text(body.id, 40);
  // A product kept for a report keeps its package as it is (lib/child-safety.ts).
  const held = await heldRefusal(store, id);
  if (held) return held;
  const sessions = Number(body.sessions);
  if (!sessions) {
    const result = await setCallPackage(ref, id, null);
    return result.ok ? Response.json({ ok: true, package: null }) : fail(result.reason);
  }
  if (!Number.isInteger(sessions) || sessions < MIN_PACKAGE_SESSIONS || sessions > MAX_PACKAGE_SESSIONS) return fail("sessions");
  const priceCents = readMoney(text(body.price, 20), store.currency);
  if (priceCents === null || priceCents <= 0 || !priceInRange(priceCents, store.currency)) return fail("price");
  const days = Number(body.days);
  if (!(PACKAGE_DAYS as readonly number[]).includes(days)) return fail("days");
  const pkg = { sessions, priceCents, days };
  const result = await setCallPackage(ref, id, pkg);
  return result.ok ? Response.json({ ok: true, package: pkg }) : fail(result.reason);
}
