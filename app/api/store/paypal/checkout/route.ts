import { type NextRequest, after } from "next/server";
import { type DigitalConsent, consentFromForm } from "@/lib/digital-consent";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readListings, readProduct } from "@/lib/catalog";
import { MIN_BUNDLE_ITEMS, deliverableItems } from "@/lib/bundle-rules";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { isComingSoon } from "@/lib/preorders";
import { countHit } from "@/lib/visit";
import { openOrder, paypalReady } from "@/lib/paypal-sales";
import { cameFrom } from "@/lib/came-from";
import { channelOfRequest } from "@/lib/visit-channel";
import { affiliateCookieName, attributionFor } from "@/lib/affiliates";
import { viaCookieName } from "@/lib/affiliate-setting";
import { readCountry } from "@/lib/fair-price";

/**
 * Starts a purchase paid with PayPal, into the creator's own PayPal account
 * (lib/paypal-sales.ts). A plain form, like the Stripe one: the product is
 * looked up by id in the store's own record and the price read from there,
 * never from the form.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });

  let handle = "";
  let productId = "";
  // The box to start access at once (lib/digital-consent.ts): from the PayPal
  // form, or from the card checkout's form when its PayPal button sent it.
  let digitalConsent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, 8_000)).formData();
    digitalConsent = consentFromForm(form);
    const h = form.get("handle");
    const p = form.get("product");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
    productId = typeof p === "string" ? p.slice(0, 64) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  const product = await readProduct(store, productId);
  if (!product) return away(`/@${store.handle}`);
  if (!(await withinLimit("checkout", `${clientAddress(request)}|${store.handle}`, 20, 600))) return away(`/@${store.handle}?status=slow`);
  if (!paypalReady(store, product)) return away(`/@${store.handle}/p/${product.id}`);
  const comingSoon = await isComingSoon(store, product.id).catch(() => null);
  if (comingSoon === null) return away(`/@${store.handle}?status=error`);
  if (comingSoon) return away(`/@${store.handle}/p/${product.id}#waitlist`);
  if (product.bundle && deliverableItems(product, await readListings(store, product.bundle)).length < MIN_BUNDLE_ITEMS) {
    return away(`/@${store.handle}`);
  }
  // What the visit carried, as a Stripe checkout carries it: the channel this
  // sale is credited to (lib/visit-channel.ts) and the affiliate who sent the
  // buyer, if one did (lib/affiliates.ts). A lookup that fails never stops the sale.
  const host = new URL(origin).hostname;
  const via = await attributionFor(store, product.id, {
    via: request.cookies.get(viaCookieName(store.handle))?.value,
    session: request.cookies.get(affiliateCookieName(store.handle))?.value,
  }).catch(() => null);
  const meta = {
    ...channelOfRequest(request, store.handle, host, Date.now() / 1000, store.attributionDays),
    ...(() => {
      const page = cameFrom(request.headers.get("referer"), host);
      return { ...(page.source ? { utm_source: page.source } : {}), ...(page.medium ? { utm_medium: page.medium } : {}), ...(page.campaign ? { utm_campaign: page.campaign } : {}) };
    })(),
  };
  // Where the buyer's connection is, for the fair price the page showed them: from the edge, as the Stripe
  // checkout reads it (app/api/store/checkout/route.ts), never from the form.
  const visitor = { ...store, visitorCountry: readCountry(request.headers.get("x-vercel-ip-country")) };
  const opened = await openOrder(visitor, product, linkOrigin(request, store), { meta, via: via && via.rate > 0 ? { aff: via.aff, rate: via.rate } : null, digitalConsent });
  if (!opened.ok && opened.reason === "consent") return away(`/@${store.handle}/p/${product.id}?consent=needed#buy`);
  if (!opened.ok) return away(opened.reason === "paused" ? `/@${store.handle}?status=paused` : `/@${store.handle}/p/${product.id}?paypal=error`);
  after(() => countHit(request, store, { kind: "checkout", id: product.id }));
  return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
}
