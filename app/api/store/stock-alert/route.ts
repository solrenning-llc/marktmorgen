import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { withinStore } from "@/lib/metered-limits";
import { readListing } from "@/lib/catalog";
import { normaliseEmail } from "@/lib/auth";
import { stockLeft } from "@/lib/stock";
import { askBackInStock, stockAlertsOpen } from "@/lib/stock-alert-send";

const MAX_BODY_BYTES = 2_000;

/**
 * "Email me when it's back" on a sold-out limited product (623 [SZ7]): a
 * plain form, like the waitlist's. Refused from another site; the store's
 * public request is taken, per connection, before the product or its stock
 * is read. The answer is always the list's own page, and the address typed
 * never goes in its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let productId = "";
  let email = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    productId = read("product").slice(0, 40);
    email = read("email").slice(0, 300);
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  let store: Awaited<ReturnType<typeof storeForHandle>>;
  try {
    store = handle ? await storeForHandle(handle) : null;
  } catch {
    return new Response("Try again in a moment.", { status: 503, headers: { "Retry-After": "60" } });
  }
  if (!store) return new Response("No such store.", { status: 404 });
  const away = (status: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}/@${store.handle}/back-in-stock?product=${encodeURIComponent(productId)}&status=${status}`, "Cache-Control": "no-store" },
    });
  if (!(await withinStore("stock-alert-ip", `${clientAddress(request)}|${store.handle}`, 10, 3_600, store))) return away("limited");
  if (honeypot.trim()) return away("sent");
  if (!stockAlertsOpen(store)) return away("closed");
  let product: Awaited<ReturnType<typeof readListing>>;
  try {
    product = productId ? await readListing(store, productId) : null;
  } catch {
    return away("error");
  }
  if (!product || product.hidden) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  const typed = email.trim();
  if (typed && !(await withinLimit("stock-alert-address", createHash("sha256").update(normaliseEmail(typed)).digest("hex"), 5, 3_600))) return away("limited");
  // Units left that cannot be read are unknown (rule 24): nothing is kept or sent.
  const left = await stockLeft(store, product).catch(() => Number.NaN);
  const result = await askBackInStock({ store, product, email, left, origin: linkOrigin(request, store) });
  return away(result);
}
