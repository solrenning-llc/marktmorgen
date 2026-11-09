import type { NextRequest } from "next/server";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH } from "@/lib/auth";
import { readListing } from "@/lib/catalog";
import { replaceFeed } from "@/lib/podcast-access";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { withinLimit } from "@/lib/request-guard";
import { guardStoreWrite, text } from "@/lib/store-request";

/** How often an hour one store may replace listeners' feeds: each may send an email. */
const LISTENER_FEEDS_AN_HOUR = 20;

/**
 * The creator replaces one listener's feed address from the studio, `{ id, email }` (audit of private podcasts, M3):
 * the listener's old address stops working at once and, while they still hold the podcast, a new one is emailed to
 * them (lib/podcast-access.ts, replaceFeed). For a feed that got out: only the listener's own email ever carries the
 * new address. Answers `{ ok, result }`, with result one of replaceFeed's.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const id = text(body.id, 40);
  const email = text(body.email, MAX_EMAIL_LENGTH + 1).trim();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return fail("email");
  if (!store.statsId) return fail("none");
  if (!(await withinLimit("podcast-listener-feed", store.statsId, LISTENER_FEEDS_AN_HOUR, 3_600))) return fail("limited", 429);
  const product = id ? await readListing(store, id) : null;
  if (!product?.podcast) return fail("unknown", 404);
  const result = await replaceFeed({ store, product, email, base: storeBase(store), from: fromStore(store) });
  if (result === "error") return fail("unavailable", 503);
  return Response.json({ ok: true, result });
}
