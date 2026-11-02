import { channelOfRequest } from "@/lib/visit-channel";
import { adsCheckout } from "@/lib/ad-events";
import { holdSession, prepareSession } from "@/lib/call-packages";
import { isSoon } from "@/lib/waitlist";
import { type NextRequest, after } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { canSellProduct } from "@/lib/store-checkout";
import { holdAndCheckout, isCallProduct, releaseOwnHold } from "@/lib/calls";
import { countHit } from "@/lib/visit";
import { HOLD_SECONDS } from "@/lib/stripe-account";
import { affiliateCookieName, attributionFor } from "@/lib/affiliates";
import { viaCookieName } from "@/lib/affiliate-setting";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { readProduct } from "@/lib/catalog";
import { chargeNow } from "@/lib/call-deposit";
import { type DepositFigures, depositWithCode, readDepositCode } from "@/lib/deposit-code";

/** The checkout this browser last opened for a call, so going back frees it. */
const HOLD_COOKIE = "nl_call_hold";

const MAX_BODY_BYTES = 1_200;

/**
 * A buyer picked a time. It is checked again, held, and the buyer is sent to
 * Stripe to pay on the creator's own account.
 *
 * The time is the only thing read from the form besides the ids; the price is
 * the creator's, read from their record here.
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
  let start = NaN;
  let tz = "";
  // A session of a package already paid for (lib/call-packages.ts).
  let pkg = "";
  // A discount code typed on the page, for a booking with a deposit only (lib/deposit-code.ts).
  let typed = "";
  // On a team that lets buyers choose: the host's position and name as the page showed them (lib/team-scheduling-rules.ts).
  let hostKey = "";
  let hostLabel = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    productId = read("product").slice(0, 40);
    const rawStart = read("start");
    start = /^\d{12,14}$/.test(rawStart) ? Number(rawStart) : NaN;
    tz = read("tz").slice(0, 64);
    pkg = read("pkg").slice(0, 60);
    typed = read("code").slice(0, 60);
    hostKey = /^[0-5]$/.test(read("host")) ? read("host") : "";
    hostLabel = read("host_label").slice(0, 60);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !productId) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  // In full: the questions the creator asks are put on the checkout.
  const product = await readProduct(store, productId);
  if (!product || !isCallProduct(product)) {
    return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}` } });
  }

  const back = (status: string) =>
    new Response(null, {
      status: 303,
      // The host the buyer chose stays chosen when they come back, so their next try is never booked with anyone else.
      headers: { Location: `${origin}/@${store.handle}/book/${product.id}?status=${status}${pkg ? `&pkg=${encodeURIComponent(pkg)}` : ""}${hostKey && status !== "host-changed" ? `&with=${hostKey}` : ""}`, "Cache-Control": "no-store" },
    });

  if (!canSellProduct(store, product)) return back("unavailable");
  if (await isSoon(store, product.id).catch(() => false)) return back("unavailable");
  if (!Number.isFinite(start)) return back("invalid");
  // Each try holds a time for half an hour while Stripe's page is open, so
  // one connection gets fifteen in ten minutes per store: enough to change
  // one's mind many times, not enough to hold a creator's whole week.
  if (!(await withinLimit("book", `${clientAddress(request)}|${store.handle}`, 15, 600))) return back("slow");

  // A buyer who went back from Stripe's page to pick again lets go of the
  // time they were holding, after that checkout is closed at Stripe.
  // A discount code on a booking with a deposit: Stripe's own box would take it
  // off the deposit alone, so it is read here, from the creator's own account,
  // and taken off the whole price; the deposit is never more than what is left
  // (the owner's decision of 2 November 2026). Refused before any time is held.
  let code: { id: string; code: string; figures: DepositFigures } | null = null;
  if (typed.trim() && !pkg && store.hasDiscounts) {
    const due = chargeNow({ priceCents: product.priceCents, currency: store.currency, deposit: product.call.deposit ?? null, inPerson: Boolean(product.call.place) });
    if (due.rest > 0) {
      const found = store.stripeAccountId ? await readDepositCode(store.stripeAccountId, typed) : null;
      if (!found) return back("code-unknown");
      const figured = depositWithCode(found, { priceCents: product.priceCents, deposit: due.cents, currency: store.currency, nowSeconds: Math.floor(Date.now() / 1000) });
      if (!figured.ok) return back(`code-${figured.why}`);
      code = { id: found.id, code: found.code, figures: figured.figures };
    }
  }
  // Typed but not usable here (the deposit or the store's codes changed since the page was drawn): said, never dropped quietly.
  if (typed.trim() && !pkg && !code) return back("code-unknown");

  const previous = request.cookies.get(HOLD_COOKIE)?.value ?? "";
  if (previous) await releaseOwnHold(store, previous).catch(() => {});

  // Sent by an affiliate within the store's window: credited to them.
  const via = await attributionFor(store, product.id, {
    via: request.cookies.get(viaCookieName(store.handle))?.value,
    session: request.cookies.get(affiliateCookieName(store.handle))?.value,
  }).catch(() => null);
  // From a package: checked, and the session's coupon made, before the time is held.
  const prepared = pkg ? await prepareSession(store, pkg, linkOrigin(request, store)) : null;
  if (prepared && !prepared.ok) return back(`pkg-${prepared.reason}`);
  const result = await holdAndCheckout({
    store,
    product,
    start,
    buyerTz: tz,
    origin: linkOrigin(request, store),
    via,
    // Where the store pays per call that takes place, the same affiliate is carried for the lead, whatever the share.
    lead: store.affiliates.lead.kind === "booking" ? via?.aff ?? null : null,
    fromPackage: prepared && prepared.ok ? prepared.fromPackage : null,
    code,
    host: hostKey ? { key: hostKey, label: hostLabel } : null,
    channel: { ...channelOfRequest(request, store.handle, new URL(origin).hostname, Date.now() / 1000, store.attributionDays), ...(await adsCheckout(request, store)) },
  });
  if (!result.ok) return back(result.reason);
  // The session counts against the package from now; if another tab took the
  // last one meanwhile, this time is let go again.
  if (prepared && prepared.ok && prepared.checkout) {
    const counted = await holdSession(store, prepared.checkout, result.session, Math.floor(Date.now() / 1000) + HOLD_SECONDS).catch(() => false);
    if (!counted) {
      await releaseOwnHold(store, result.session).catch(() => {});
      return back("pkg-used");
    }
  }
  after(() => countHit(request, store, { kind: "checkout", id: product.id }));
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      Location: result.url,
      "Cache-Control": "no-store",
      "Set-Cookie": `${HOLD_COOKIE}=${result.session}; Path=/api/store/book; Max-Age=${HOLD_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
