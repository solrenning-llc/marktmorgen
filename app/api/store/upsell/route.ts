import type { NextRequest } from "next/server";
import { type DigitalConsent, consentFromForm } from "@/lib/digital-consent";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { UPSELL_COOKIE, takeUpsell } from "@/lib/upsell";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

/**
 * The buyer answered an offer on the thanks page. "Yes" is charged to the
 * card they just used, only from the browser that paid, once; "No thanks"
 * charges nothing and moves on to whatever the creator put next.
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
  let session = "";
  let step = "";
  let answer: "yes" | "no" | "" = "";
  // This offer's own box to start access at once (lib/digital-consent.ts), read only with a yes.
  let consent: DigitalConsent | null = null;
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    consent = consentFromForm(form);
    const h = form.get("handle");
    const s = form.get("session_id");
    const t = form.get("step");
    handle = typeof h === "string" ? normaliseHandle(h) : "";
    session = typeof s === "string" ? s.slice(0, 220) : "";
    // The step as the page drew it: its id and the fingerprint of its terms (lib/upsell.ts, offerRef).
    step = typeof t === "string" ? t.slice(0, 64) : "";
    // Only the button that says yes adds anything; a form that says neither
    // does nothing at all.
    const a = form.get("answer");
    answer = a === "yes" || a === "no" ? a : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle || !session || !step || !answer) return new Response("Bad request", { status: 400 });

  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  const back = (status: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${origin}/@${store.handle}/thanks?session_id=${encodeURIComponent(session)}&upsell=${status}`,
        "Cache-Control": "no-store",
      },
    });
  // A yes is a new sale on the creator's account: refused, as the store's
  // other checkouts refuse it (lib/store-checkout.ts, canSell), in a store
  // switched off after notices (lib/takedown.ts), whose plan is not paid or
  // whose Stripe account is not cleared — before Stripe is asked anything
  // and before anything is written. A no is refused the same: nothing to answer.
  if (!canSell(store)) return back("unavailable");
  if (!(await withinLimit("upsell", `${clientAddress(request)}|${store.handle}`, 30, 600))) {
    return new Response("Too many tries. Wait a few minutes.", { status: 429, headers: { "Cache-Control": "no-store" } });
  }

  let result: Awaited<ReturnType<typeof takeUpsell>>;
  try {
    result = await takeUpsell({
      store,
      session,
      secret: request.cookies.get(UPSELL_COOKIE)?.value,
      origin: linkOrigin(request, store),
      step,
      answer,
      consent: answer === "yes" ? consent : null,
    });
  } catch (error) {
    // Something the answer depends on could not be read (CX-123 rule 24): thrown before anything is charged.
    console.error("answering an offer failed", error);
    return new Response("That offer could not be answered just now, and nothing was charged for it. Go back and try again in a moment.", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (result.kind === "confirm") {
    return new Response(null, { status: 303, headers: { Location: result.url, "Cache-Control": "no-store" } });
  }
  return back(result.kind);
}
