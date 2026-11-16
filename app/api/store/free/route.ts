import { shareAddress, visitorAddress } from "@/lib/traffic-rules";
import { type NextRequest, after } from "next/server";
import { allowedBy, newLeadId, sendServerLead, sendsFromServer } from "@/lib/ad-events";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { requestCopy } from "@/lib/free";
import { leadAffiliate, visitCookies } from "@/lib/affiliate-leads";
import { countHit, isStorePeople } from "@/lib/visit";
import { markFromReferer } from "@/lib/page-funnel";
import { countFunnelDone, funnelHere, funnelVisitor } from "@/lib/page-funnel-store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { withinStore } from "@/lib/metered-limits";

/** The copies of one store a connection (its /64) may ask for in an hour, the same as lib/free.ts IP_LIMIT. */
const CONNECTION_PER_HOUR = 20;
/** The copies of one store that a whole IPv6 /48 can ask for in an hour: ten connections' worth. */
const NET_PER_HOUR = 200;

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

  // Two counts, as each copy is one of the month's orders that paid orders share (lib/order-rules.ts; #4626). The
  // raw address let every address of an IPv6 network have its own 20 copies an hour. One connection is its /64
  // (visitorAddress), the least one customer is handed: its 20 copies an hour (lib/free.ts). Not a /48, which a mobile
  // carrier shares among thousands of subscribers, so one of them would use up every other's copies (Claude 7 on
  // #4636). And a whole /48, which a tunnel hands one person with 65,536 /64s in it, at most NET_PER_HOUR copies of
  // this store an hour, counted before anything else is read. An IPv4 address counts by itself in both.
  const address = clientAddress(request);
  const ip = visitorAddress(address) || "unknown";
  const net = shareAddress(address) || "unknown";
  // The connection's own 20 first, so an ask its /64 is refused never reaches the /48's count: one phone asking 200
  // times can add at most 20 to it and never locks its carrier's other subscribers out (Claude 6 on #4636).
  // Each count is one of the store's public requests (withinStore), so the commands an ask runs before requestCopy
  // sit in the store's measured public-requests line, not in a guard with no price (Claude 7 on #4636).
  if (!(await withinStore("free-conn", `${ip}|${store.handle}`, CONNECTION_PER_HOUR, 3_600, store))) return away(`${page}&status=limited`);
  if (!(await withinStore("free-net", `${net}|${store.handle}`, NET_PER_HOUR, 3_600, store))) return away(`${page}&status=limited`);

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
        await countFunnelDone(statsId, here.funnel, here.index, funnelVisitor(statsId, here.funnel.id, address, request.headers.get("user-agent") ?? ""));
      });
    }
    return away(`${page}&status=${result}${lead ? `&e=${lead}` : ""}`);
  } catch (error) {
    console.error("sending a free copy failed", error);
    return away(`${page}&status=error`);
  }
}
