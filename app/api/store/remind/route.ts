import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { readListing, readListings } from "@/lib/catalog";
import { readCartIds } from "@/lib/cart-rules";
import { askCartReminder, askReminder } from "@/lib/checkout-ask";
import { type AskWhen, isAskWhen } from "@/lib/ask-when";

const MAX_BODY_BYTES = 2_000;

/**
 * A buyer asks for one reminder about a checkout they did not finish
 * (lib/checkout-ask.ts): a plain form on the page the checkout's way back
 * leads to, or on the product's own page (`from=page`, with `when`). The
 * answer is always the page it was asked on, and the address typed never
 * goes in its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let productId = "";
  let cart: string[] = [];
  let email = "";
  let honeypot = "";
  let fromPage = false;
  let when: AskWhen = "hour";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    productId = read("product").slice(0, 40);
    // A whole cart, from the way back from its checkout (lib/checkout-ask.ts, askCartReminder).
    cart = readCartIds(read("cart").slice(0, 400).split(","));
    email = read("email").slice(0, 300);
    honeypot = read("website");
    fromPage = read("from") === "page";
    const asked = read("when");
    if (isAskWhen(asked)) when = asked;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  // One of the store's public requests for its window (lib/traffic.ts).
  const taken = await takePublicRequest(store).catch(unknownLimit);
  if (!taken) return new Response("Please try again later.", { status: 429 });
  const away = (status: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: fromPage
          ? `${origin}/@${store.handle}/p/${encodeURIComponent(productId)}?asked=${status}&when=${when}#remind`
          : cart.length
            ? `${origin}/@${store.handle}/left?cart=${cart.map(encodeURIComponent).join(",")}&status=${status}`
            : `${origin}/@${store.handle}/left?p=${encodeURIComponent(productId)}&status=${status}`,
        "Cache-Control": "no-store",
      },
    });
  // A count that could not be read is never "try again later" (rule 24): the form's own error notice, nothing asked.
  if (taken === "unknown") return away("error");
  // A form filled in by something that fills in every field is told it worked.
  if (honeypot.trim()) return away("asked");
  try {
    if (cart.length) return away(await askCartReminder({ store, items: await readListings(store, cart), email, ip: clientAddress(request) }));
    const product = productId ? await readListing(store, productId) : null;
    return away(await askReminder({ store, product, email, ip: clientAddress(request), from: fromPage ? "page" : "checkout", when }));
  } catch (error) {
    console.error("asking for a checkout reminder failed", error);
    return away("error");
  }
}
