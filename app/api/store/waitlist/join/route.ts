import { after } from "next/server";
import { countHit } from "@/lib/visit";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { joinWaitlist } from "@/lib/waitlist";
import { allowedBy, newLeadId, sendServerLead, sendsFromServer } from "@/lib/ad-events";

const MAX_BODY_BYTES = 2_000;

/**
 * Joins a product's waitlist: a plain form, like the buy button. The answer
 * is always the waitlist page, and the address typed never goes in its URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let productId = "";
  let email = "";
  let consent = false;
  let clicks = false;
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
    consent = read("consent") === "yes";
    // Its own box, counted only with the first (lib/mail-clicks.ts).
    clicks = consent && read("clicks") === "yes";
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  // Switched off after notices about its content (lib/takedown.ts): no sign-up
  // is taken, as on its list and its free copy; the answer is the store's page.
  const product = productId && !store.suspended ? await readListing(store, productId) : null;
  const away = (status: string, lead = "") =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}/@${store.handle}/waitlist?product=${encodeURIComponent(productId)}&status=${status}${lead ? `&e=${lead}` : ""}`, "Cache-Control": "no-store" },
    });
  if (!product || product.hidden) return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}` } });
  if (honeypot.trim()) return away("sent");
  try {
    const result = await joinWaitlist({ store, product, email, consent, clicks, ip: clientAddress(request), origin: linkOrigin(request, store) });
    // Counted under the channel the visitor came from (lib/visit-channel.ts).
    if (result === "sent") after(() => countHit(request, store, { kind: "signup" }));
    // The sign-up as a lead to the creator's ad platforms, with the visitor's yes (lib/ad-events.ts).
    const lead = result === "sent" && sendsFromServer(store) && allowedBy(request, store) ? newLeadId() : "";
    if (lead) after(() => sendServerLead(store, request, { id: lead, email, product: product.id }).catch((error) => console.error("sending a lead failed", error)));
    return away(result, lead);
  } catch (error) {
    console.error("joining a waitlist failed", error);
    return away("error");
  }
}
