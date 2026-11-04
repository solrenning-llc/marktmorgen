import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { preorderWords } from "@/lib/buyer-words/preorder";
import { type Listing, type Store, normaliseHandle, storeForHandle } from "@/lib/store";
import { readOrder } from "@/lib/store-checkout";
import { plain, serveFile } from "@/lib/serve-file";
import { offerRefunded, upsellDelivery } from "@/lib/upsell";
import { OrdersBusy, findPurchase } from "@/lib/buyer-orders";
import { stampedCopy, wantsStamp } from "@/lib/pdf-stamp";
import { renewPath } from "@/lib/membership-access";
import { originFrom } from "@/lib/request-origin";
import type { ProductFile } from "@/lib/product-file";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { ordersWords } from "@/lib/buyer-words/orders";
import { downloadRenewalWords } from "@/lib/buyer-words/download-renewal";
import { parseLanguage } from "@/lib/store-language";
import { createHash, randomBytes } from "node:crypto";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { checkSingleDigitalRenewal, readSingleDigitalAccess, singleDigitalRenewalCovered, singleDigitalRenewalIdentity } from "@/lib/single-digital-access";
import { confirmationOutboxPolicy, enqueueSingleDigitalRenewal } from "@/lib/order-confirmation-outbox";
import type { ShipmentMailRuntime } from "@/lib/shipment-mail-outbox";

/**
 * Hands the buyer the file they paid for.
 *
 * The only thing that opens this door is a Stripe session that Stripe itself
 * says is paid, checked on every request rather than written down here. The
 * blob's own URL never leaves the server, because a URL that works is a URL
 * that can be forwarded.
 *
 * A membership's file is handed over only while the membership runs, which is
 * read from Stripe in the same request; once it has ended the buyer is sent
 * to a page that says so and offers the way back (lib/membership-access.ts).
 *
 * A PDF on a product whose creator switched stamping on goes out with the
 * buyer's email on every page (lib/pdf-stamp.ts), and an EPUB with the same
 * line as an invisible mark inside the book (lib/epub-stamp.ts), which can
 * take a few seconds the first time for a big book: hence the longer time
 * limit.
 */
export const maxDuration = 60;

/**
 * How often one order's link may be opened in an hour. Each opening asks
 * Stripe about the order on the creator's own account and runs a function
 * here, and nothing else bounded it: a script looping on one link would run
 * up our bill and spend the creator's allowance of requests at Stripe. A
 * bundle of every file a store sells, downloaded twice, fits well inside it.
 */
const OPENS_PER_HOUR = 240;

/** The status of each answer to an order that is not paid; its words are the store's (lib/buyer-words/orders.ts). */
const STATUSES = {
  unpaid: 402,
  processing: 402,
  expired: 410,
  invalid: 404,
  unavailable: 503,
  error: 502,
  refunded: 410,
} as const;

/** The file, stamped with its buyer's email when the product asks for it (a PDF or an EPUB). */
async function deliver(
  store: Store,
  product: Listing,
  file: ProductFile,
  sale: { reference: string; email: string | null; paidAt: number },
): Promise<Response> {
  if (wantsStamp(product.stamp, file) && sale.email) {
    const copy = await stampedCopy(file, { reference: sale.reference, email: sale.email, paidAt: sale.paidAt }, store);
    if (copy) return serveFile(copy);
  }
  return serveFile(file);
}

/**
 * One product of a bundle, asked for by its id (`pid`): only one the order's
 * own list names, and only as the store has it now (lib/bundles.ts).
 */
function pick(items: { items: Listing[] } | null | undefined, pid: string): Listing | null {
  if (!items || !pid) return null;
  return items.items.find((p) => p.id === pid) ?? null;
}

function toRenew(request: NextRequest, store: Store, product: Pick<Listing, "id">): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${originFrom(request)}${renewPath(store, product)}`, "Cache-Control": "no-store" },
  });
}

function htmlValue(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function privatePage(language: unknown, title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="${parseLanguage(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlValue(title)}</title></head><body><main><h1>${htmlValue(title)}</h1>${body}</main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" },
  });
}

/** Production GET and directed tests share the complete paid-file branch. */
export async function paidDownloadGet(request: NextRequest, runtime: ShipmentMailRuntime = {}) {
  const handle = normaliseHandle(
    request.nextUrl.searchParams.get("handle") ?? "",
  );
  if (!handle) return plain(400, "Which store?");

  const store = await storeForHandle(handle);
  if (!store) return plain(404, "We could not find this store.");
  // Told in the store's own language from here on.
  const say = ordersWords(store.language).downloadProblems;

  // Asked for again from the emailed list of purchases: the link's address
  // must still have paid for this one, by Stripe's account of it right now.
  const token = request.nextUrl.searchParams.get("token");
  // Counted by the link, before anything is asked of Stripe.
  const link = token ? `t:${token}` : `s:${request.nextUrl.searchParams.get("session_id") ?? ""}`;
  const tooOften = () =>
    new Response(say.tooOften, {
      status: 429,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "600", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    });
  if (!(await withinStore("download", `${store.handle}:${link}`, OPENS_PER_HOUR, 3600, store, "buyer"))) return tooOften();
  // Presence, including an invalid/empty value, selects this exact original
  // paid reference. It must never fall back to the recent40 purchase scan.
  if (request.nextUrl.searchParams.has("origin")) {
    const capsule = request.nextUrl.searchParams.get("origin") ?? "";
    try {
      const access = await readSingleDigitalAccess(store, token ?? "", capsule);
      if (access?.product.file) return deliver(store, access.product, access.product.file, access);
      const policy = confirmationOutboxPolicy(runtime, false);
      if (singleDigitalRenewalCovered(policy) && singleDigitalRenewalIdentity(store, capsule)) {
        const renewal = await checkSingleDigitalRenewal(store, capsule);
        const words = downloadRenewalWords(store.language);
        if (renewal.status === "not_paid") return plain(410, words.notPaid);
        if (renewal.status === "unknown") return plain(503, say.purchaseCheckFailed);
        const fields = { handle: store.handle, origin: capsule, request: randomBytes(32).toString("hex") };
        return privatePage(store.language, words.title, `<p>${htmlValue(words.intro)}</p><form method="post" action="/api/store/download?language=${parseLanguage(store.language)}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${htmlValue(value)}">`).join("")}<button type="submit">${htmlValue(words.button)}</button></form>`);
      }
      return plain(410, say.linkExpired);
    } catch {
      console.error("checking an original paid file failed");
      return plain(502, say.purchaseCheckFailed);
    }
  }
  if (token) {
    // Only the purchase asked for is read, by its reference, paid for before each read (lib/buyer-orders.ts, findPurchase):
    // a store with no room left for it is answered as too often, and nothing more is asked of Stripe.
    let found;
    try {
      found = await findPurchase(store, token, request.nextUrl.searchParams.get("ref") ?? "", {
        pid: request.nextUrl.searchParams.get("pid") ?? "",
        // Only a key a product ticked at checkout goes under (lib/bundle-rules.ts, BUMP_KEYS); any other is not one.
        item: (BUMP_KEYS as readonly string[]).includes(request.nextUrl.searchParams.get("item") ?? "") ? request.nextUrl.searchParams.get("item") ?? "" : "",
      });
    } catch (error) {
      if (error instanceof OrdersBusy) return tooOften();
      console.error("looking up a purchase failed", error);
      return plain(502, say.purchaseCheckFailed);
    }
    if (!found) {
      return plain(410, say.linkExpired);
    }
    // The listing of what is handed over (stamped or not) is the one the lookup already read: nothing is read again.
    const { purchase, email, listing } = found;
    if (purchase.ended) return toRenew(request, store, { id: purchase.productId });
    // A product ticked at checkout is asked for by the key its order names it under.
    const asked = request.nextUrl.searchParams.get("item") ?? "";
    const bumped = (BUMP_KEYS as readonly string[]).includes(asked) ? purchase.added.find((added) => added.key === asked) ?? null : null;
    if ((BUMP_KEYS as readonly string[]).includes(asked) && !bumped) return plain(404, say.nothingToDownload);
    // A product of a bundle on this purchase, by its id.
    const pid = request.nextUrl.searchParams.get("pid") ?? "";
    if (pid) {
      const line = (bumped ? bumped.items : purchase.items)?.lines.find((l) => l.productId === pid) ?? null;
      if (!line || !line.delivery) return plain(404, say.nothingToDownload);
      if (!line.delivery.file) return plain(409, say.notADownloadPurchases);
      const item = await listing(line.productId);
      if (!item) return plain(404, say.nothingToDownload);
      return deliver(store, item, line.delivery.file, { reference: purchase.reference, email, paidAt: purchase.paidAt });
    }
    const delivery = bumped ? bumped.delivery : purchase.main;
    if (!delivery) return plain(404, say.nothingToDownload);
    if (!delivery.file) {
      return plain(409, say.notADownloadPurchases);
    }
    const owner = await listing(bumped ? bumped.id : purchase.productId);
    if (!owner) return serveFile(delivery.file);
    return deliver(store, owner, delivery.file, { reference: purchase.reference, email, paidAt: purchase.paidAt });
  }

  const sessionId = request.nextUrl.searchParams.get("session_id") ?? "";
  const order = await readOrder(store, sessionId || undefined);
  if (order.state !== "paid") {
    return plain(STATUSES[order.state], say[order.state]);
  }
  // A membership that has ended hands nothing over any more.
  if (order.membership === "ended") return toRenew(request, store, order.product);
  // A gift is its recipient's, opened from their own email (lib/gifts.ts).
  if (order.gift) return plain(403, say.gift);
  // Bought for several: each person opens it from their own place (lib/group-buy.ts).
  if (order.group) return plain(403, say.group);
  // A pre-order opens the day it comes out, from the email sent then (lib/preorders.ts).
  if (order.preorder) return plain(403, preorderWords(store.language).notYet);
  const sale = { reference: order.reference, email: order.email, paidAt: order.created };
  const pid = request.nextUrl.searchParams.get("pid") ?? "";

  // A product taken in one click after paying: only once Stripe said so.
  // `step` names which offer, and is left out for the first.
  if (request.nextUrl.searchParams.get("item") === "upsell") {
    const added = await upsellDelivery(
      store,
      request.nextUrl.searchParams.get("session_id") ?? "",
      request.nextUrl.searchParams.get("step") ?? "",
    );
    if (!added) return plain(404, say.nothingAdded);
    const inside = pid ? pick(added.items, pid) : null;
    if (pid && !inside) return plain(404, say.addedNoPart);
    // Its own payment, refunded in full since, hands nothing over any more.
    try {
      if (await offerRefunded(store, added.reference)) return plain(410, say.addedRefunded);
    } catch (error) {
      console.error("checking an added product failed", error);
      return plain(502, say.error);
    }
    const wanted = inside ?? added.product;
    if (!wanted.file) {
      return plain(wanted.link ? 409 : 404, wanted.link ? say.notADownloadOrder : say.noFile);
    }
    return deliver(store, wanted, wanted.file, { ...sale, reference: added.reference, paidAt: added.paidAt });
  }

  // A product added at checkout has its own file, asked for by the key the
  // order names it under (lib/bundle-rules.ts, BUMP_KEYS).
  const item = request.nextUrl.searchParams.get("item") ?? "";
  if ((BUMP_KEYS as readonly string[]).includes(item)) {
    const added = order.bumps.find((one) => one.key === item);
    if (!added) return plain(404, say.nothingAdded);
    if (pid) {
      const inside = pick(added.items, pid);
      if (!inside) return plain(404, say.addedToOrderNoPart);
      if (!inside.file) return plain(inside.link ? 409 : 404, inside.link ? say.notADownloadPurchases : say.noFile);
      return deliver(store, inside, inside.file, sale);
    }
    if (!added.file) {
      return plain(added.link ? 409 : 404, added.link ? say.notADownloadOrder : say.noFile);
    }
    return deliver(store, added.product, added.file, sale);
  }

  // One product of the bundle that was bought, by its id.
  if (request.nextUrl.searchParams.get("item") === "bundle") {
    const inside = pick(order.items, pid);
    if (!inside) return plain(404, say.noSuchProduct);
    if (!inside.file) return plain(inside.link ? 409 : 404, inside.link ? say.notADownloadPurchases : say.noFile);
    return deliver(store, inside, inside.file, sale);
  }

  // The file of the option that was bought, when the product has options, and
  // the product's own when it does not. Worked out once, in readOrder, so this
  // route and the page the buyer is looking at can never disagree.
  const file = order.file;
  if (!file) {
    // A product that delivers a link has nothing here to send. The buyer is
    // told where it actually is rather than that their purchase is missing.
    if (order.link) {
      return plain(409, say.productNotADownload);
    }
    return plain(404, say.noFile);
  }

  return deliver(store, order.product, file, sale);
}

export async function GET(request: NextRequest) {
  return paidDownloadGet(request);
}

/** Only an explicitly funded renewal intent is saved. No grant, payment,
 * provider send or fresh token is issued by this request. */
export async function paidDownloadRenewalPost(request: NextRequest, runtime: ShipmentMailRuntime = {}): Promise<Response> {
  // This hint controls only early error presentation; the loaded store owns
  // all later wording and the existing capsule remains the authorization.
  const earlyWords = downloadRenewalWords(request.nextUrl.searchParams.get("language"));
  if (fromAnotherSite(request)) return plain(403, earlyWords.sameSite);
  if (!singleDigitalRenewalCovered(confirmationOutboxPolicy(runtime))) return plain(503, earlyWords.unavailable);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return plain(415, earlyWords.badForm);
  let fields: URLSearchParams;
  try { fields = new URLSearchParams(await (await limited(request, 16_384)).text()); }
  catch { return plain(400, earlyWords.unreadable); }
  const names = [...fields.keys()];
  if (names.length !== 3 || new Set(names).size !== 3 || names.some(name => !["handle", "origin", "request"].includes(name))) return plain(400, earlyWords.incomplete);
  const handle = normaliseHandle(fields.get("handle") ?? ""), capsule = fields.get("origin") ?? "", nonce = fields.get("request") ?? "";
  if (!handle || !/^[a-f0-9]{64}$/.test(nonce)) return plain(400, earlyWords.incomplete);
  const store = await storeForHandle(handle);
  if (!store) return plain(404, earlyWords.missingStore);
  const words = downloadRenewalWords(store.language);
  const identity = singleDigitalRenewalIdentity(store, capsule);
  if (!identity) return plain(404, words.invalid);
  const person = createHash("sha256").update(`${store.sid}\n${identity.email}`).digest("hex");
  if (!(await withinStore("download", `${store.handle}:renew:${person}`, 5, 3600, store, "buyer"))) return plain(429, words.tooOften);
  const result = await enqueueSingleDigitalRenewal(store, capsule, nonce, runtime);
  if (!result.ok) return plain(result.reason === "not_paid" ? 410 : 503, result.reason === "not_paid" ? words.notPaid : result.reason === "capacity" ? words.capacity : result.reason === "acceptance_unknown" ? words.acceptanceUnknown : result.reason === "on_hold" ? words.onHold : result.reason === "refused" ? words.refused : words.unavailable);
  return privatePage(store.language, words.savedTitle, `<p>${htmlValue(words.savedBody)}</p>`);
}

export async function POST(request: NextRequest) {
  return paidDownloadRenewalPost(request);
}
