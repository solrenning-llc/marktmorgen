import { type NextRequest, after } from "next/server";
import { allowedBy, newLeadId, sendServerLead, sendsFromServer } from "@/lib/ad-events";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { requestCopy } from "@/lib/free";
import { leadAffiliate, visitCookies } from "@/lib/affiliate-leads";
import { countHit, isStorePeople } from "@/lib/visit";
import { markFromReferer } from "@/lib/page-funnel";
import { countFunnelDone, funnelHere, funnelVisitor } from "@/lib/page-funnel-store";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";

const MAX_BODY_BYTES = 2_000;

/**
 * Asks for a free copy of something on a store.
 *
 * A plain HTML form, like the buy button, so it works with JavaScript turned
 * off. The answer is always a page, never a file: the copy goes to the inbox
 * that was typed, because that is the only way to know the address is real.
 *
 * The address typed never appears in the URL this sends the visitor to. A URL
 * ends up in browser history, in server logs and in whatever analytics a page
 * has, and none of those is a place for somebody's email.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);

  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return new Response("Too large", { status: 413 });
  }

  const away = (path: string) =>
    new Response(null, {
      status: 303,
      headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" },
    });

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
    // Only an explicit "yes" counts. A box that is missing, empty or carries
    // anything else is a box that was not ticked.
    consent = read("consent") === "yes";
    // Its own box, which counts only with the first (lib/mail-clicks.ts).
    clicks = consent && read("clicks") === "yes";
    honeypot = read("website");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  const product = await readListing(store, productId);
  if (!product) return away(`/@${store.handle}`);
  // Switched off after notices about its content (lib/takedown.ts): nothing is handed out.
  if (store.suspended) return away(`/@${store.handle}`);

  // Asked for from a step of a funnel of pages (lib/page-funnel.ts): the page
  // after the form leads on to the next step, and the sign-up is counted for it.
  const mark = markFromReferer(request.headers.get("referer"), new URL(origin).hostname);
  const here = mark ? await funnelHere(store, mark, "product", product.id).catch(() => null) : null;
  const page = `/@${store.handle}/free?product=${encodeURIComponent(product.id)}${here ? `&f=${here.funnel.id}` : ""}`;

  // A field no person can see. Whatever filled it in is told it worked, so it
  // learns nothing, and no email goes anywhere.
  if (honeypot.trim()) return away(`${page}&status=sent`);

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  try {
    // Sent by an affiliate, where the store pays per free product claimed: credited only once the emailed link is used.
    const leadFor = await leadAffiliate(store, "free", visitCookies(request, store.handle), email);
    const result = await requestCopy({ store, product, email, consent, clicks, ip, origin: linkOrigin(request, store), lead: leadFor });
    if (result === "sent") after(() => countHit(request, store, { kind: "checkout", id: product.id, free: true }));
    // The sign-up as a lead to the creator's ad platforms, with the buyer's yes (lib/ad-events.ts),
    // and its id on the page it lands on, so the pixel's lead and this one count once.
    // Without the address: it is not confirmed yet, so it may be someone else's, who never said yes.
    const lead = result === "sent" && sendsFromServer(store) && allowedBy(request, store) ? newLeadId() : "";
    if (lead) after(() => sendServerLead(store, request, { id: lead, email: "", product: product.id }).catch((error) => console.error("sending a lead failed", error)));
    if (result === "sent" && here && store.statsId) {
      const statsId = store.statsId;
      after(async () => {
        if (await isStorePeople(request, store)) return;
        await countFunnelDone(statsId, here.funnel, here.index, funnelVisitor(statsId, here.funnel.id, ip, request.headers.get("user-agent") ?? ""));
      });
    }
    return away(`${page}&status=${result}${lead ? `&e=${lead}` : ""}`);
  } catch (error) {
    console.error("sending a free copy failed", error);
    return away(`${page}&status=error`);
  }
}
