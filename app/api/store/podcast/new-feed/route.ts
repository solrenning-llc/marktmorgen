import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { readFeedToken, replaceFeed } from "@/lib/podcast-access";
import { FEED_TOKEN, PLAY_REQUEST_UNITS } from "@/lib/podcast-rules";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { fromStore, storeBase } from "@/lib/purchase-email";

/** How often an hour one connection, and one feed, may ask for a new feed address. */
const NEW_FEED_IP_LIMIT = 10;
const NEW_FEED_TOKEN_LIMIT = 3;

/**
 * "Get a new feed address", confirmed on the buyer's own feed page (audit of private podcasts, M3): the feed the page
 * shows stops working at once, and a new one is emailed to the address that bought the podcast, while it still holds
 * it (lib/podcast-access.ts, replaceFeed). The new address is never shown here: whoever asks with an address that got
 * out cannot take the new one. The store's public requests are taken before the product or the feed is read, as many
 * as an episode's (Stripe is asked whether the address still holds the podcast).
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let productId = "";
  let token = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    productId = String(form.get("product") ?? "").slice(0, 40);
    token = String(form.get("token") ?? "").slice(0, 60);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !FEED_TOKEN.test(token)) return new Response(null, { status: 303, headers: { Location: `${origin}/`, "Cache-Control": "no-store" } });
  const page = `${origin}/@${store.handle}/podcast/${encodeURIComponent(productId)}`;
  const away = (status: string) => new Response(null, { status: 303, headers: { Location: `${page}?status=${status}`, "Cache-Control": "no-store" } });
  if (!(await withinLimit("podcast-new-ip", `${store.handle}:${clientAddress(request)}`, NEW_FEED_IP_LIMIT, 3_600))) return away("limited");
  if (!(await withinLimit("podcast-new-feed", createHash("sha256").update(token).digest("hex").slice(0, 32), NEW_FEED_TOKEN_LIMIT, 3_600))) return away("limited");
  if (!(await takeBuyerRead(store, PLAY_REQUEST_UNITS))) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/resting`, "Cache-Control": "no-store" } });
  const product = productId ? await readListing(store, productId) : null;
  if (!product?.podcast) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  // An unknown read of the grant changes nothing (CX-123 rule 24).
  const grant = await readFeedToken(token).catch(() => undefined);
  if (grant === undefined) return away("error");
  // A token that opens no feed of this product here has nothing to replace: the page says the old address is gone.
  if (!grant || grant.s !== store.statsId || grant.p !== product.id) return away("renewed");
  const result = await replaceFeed({ store, product, email: grant.e, base: storeBase(store), from: fromStore(store) });
  return away(result === "error" || result === "unsent" ? "error" : "renewed");
}
