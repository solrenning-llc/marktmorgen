import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { isCallProduct, moveBooking, packageOf } from "@/lib/calls";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";

const MAX_BODY_BYTES = 1_000;

/**
 * A buyer moves their booking to another time, from the link in their email.
 *
 * The checkout session is the key, as on the thanks page, and it is checked
 * against Stripe here: it has to be a paid booking of this very product in
 * this store. Nothing is charged or refunded; the seat moves, and the rules
 * for how late and how often are moveBooking's.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  let handle = "";
  let productId = "";
  let session = "";
  let start = NaN;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    productId = read("product").slice(0, 40);
    session = read("session").slice(0, 250);
    const rawStart = read("start");
    start = /^\d{12,14}$/.test(rawStart) ? Number(rawStart) : NaN;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId || !session) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  const product = await readListing(store, productId);
  if (!product || !isCallProduct(product)) {
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}` } });
  }

  const back = (status: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${origin}/@${store.handle}/book/${product.id}?move=${encodeURIComponent(session)}&status=${status}`,
        "Cache-Control": "no-store",
      },
    });

  if (!Number.isFinite(start)) return back("invalid");
  if (!(await withinStore("book-move", `${clientAddress(request)}|${store.handle}`, 10, 600, store, "buyer"))) return back("slow");
  const order = await readOrder(store, session);
  if (order.state !== "paid" || !order.call || order.product.id !== product.id) {
    return back(order.state === "error" || order.state === "unavailable" ? "error" : "unknown");
  }

  const result = await moveBooking({
    store,
    product,
    session,
    booked: { start: order.call.start, end: order.call.end, email: order.email, buyerTz: order.call.buyerTz },
    start,
    origin: linkOrigin(request, store),
    // A session from a package: a move made before its confirmation writes it down there too (lib/call-packages.ts).
    fromPackage: packageOf(order.record.metadata),
  });
  return back(result.ok ? "moved" : result.reason);
}
