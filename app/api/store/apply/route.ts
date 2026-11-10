import type { NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { originFrom } from "@/lib/request-origin";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { readListingExactly } from "@/lib/catalog";
import { productSegment } from "@/lib/product-slug";
import { takePublicRequest } from "@/lib/traffic";
import { APPLY_PER_CONNECTION_HOUR, APPLY_SUBMIT_REQUEST_UNITS, type ApplyStatus, isApplyFirst, submitApplication } from "@/lib/apply-first-store";

/** The form's fields, with room to spare: a handle, a product id, an address, two words and a version. */
const MAX_BODY_BYTES = 2_000;

/**
 * An application to buy a product that asks for one first (604 [WP3], lib/apply-first-store.ts):
 * a plain HTML form on the product's own page, so it works with JavaScript off.
 *
 * In this order: another site is refused before anything is read; the body is
 * read only up to its cap; the store is found by its handle; then the store's
 * public requests for the application are taken (APPLY_SUBMIT_REQUEST_UNITS),
 * before the product, the mode or any application is read, and a store whose
 * requests are used keeps nothing. The person must have checked the box with
 * the sentence of the version the form showed (APPLY_CONSENT_VERSION), which
 * is kept with the application. No email is sent and no checkout is opened.
 *
 * The answer is always the product's page, told only a status word.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let productId = "";
  let email = "";
  let consent = false;
  let version = "";
  let honeypot = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    handle = normaliseHandle(read("handle", 80));
    productId = read("product", 64);
    email = read("email", 300);
    consent = read("consent", 3) === "yes";
    version = read("version", 40);
    honeypot = read("website", 200);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store || store.suspended) return new Response("No such store.", { status: 404 });
  const home = () => new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}`, "Cache-Control": "no-store" } });
  let page = "";
  const answer = (status: ApplyStatus) =>
    page
      ? new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/p/${page}?apply=${status}#apply`, "Cache-Control": "no-store" } })
      : home();

  const now = Date.now();
  // Paid before anything about the application is read: a store whose requests are used keeps nothing.
  if (!(await takePublicRequest(store, "public", now, APPLY_SUBMIT_REQUEST_UNITS))) return home();
  const product = await readListingExactly(store, productId);
  if (product === "unknown") return home();
  if (!product || product.hidden) return home();
  page = productSegment(product);
  // A field no person can see: whatever filled it in is told it worked, and nothing is kept.
  if (honeypot.trim()) return answer("sent");

  try {
    if (!(await withinStore("apply-ip", `${store.sid}:${clientAddress(request)}`, APPLY_PER_CONNECTION_HOUR, 3_600, store))) return answer("limited");
    if (!(await isApplyFirst(store, product.id))) return answer("closed");
    if (!consent) return answer("consent");
    const kept = await submitApplication(store, { offer: product.id, email, consentVersion: version }, now);
    if (kept.ok) return answer("sent");
    const status: Record<typeof kept.reason, ApplyStatus> = {
      "bad-input": "email",
      consent: "consent",
      day: "busy",
      full: "full",
      person: "person",
      unavailable: "error",
    };
    return answer(status[kept.reason]);
  } catch (error) {
    console.error("keeping an application failed", error);
    return answer("error");
  }
}
