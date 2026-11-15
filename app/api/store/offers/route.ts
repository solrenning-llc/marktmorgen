import type { NextRequest } from "next/server";
import { offersTokenOk, stopOffers, stopOffersForAccount } from "@/lib/offer-stop";
import { SESSION_COOKIE, sessionEmail } from "@/lib/auth";
import { clientAddress, fromAnotherSite, withinLimit } from "@/lib/request-guard";

/**
 * Stops the offers Marktmorgen emails a creator (lib/offer-stop.ts), from the link at the foot of such an email. The
 * link carries the store's id and a token signed for it, so nobody can stop somebody else's. A GET only shows the
 * button: mail apps open links to check them. A POST stops them: the button, or a mail app's one-click unsubscribe
 * (RFC 8058, List-Unsubscribe=One-Click), which proxy.ts lets in from any site.
 */
function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1b29}button{font:inherit;min-height:44px;padding:.6rem 1.1rem;border-radius:.6rem;border:0;background:#5b3fd6;color:#fff;cursor:pointer}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function read(request: NextRequest): { sid: string; token: string } | null {
  const params = request.nextUrl.searchParams;
  const sid = (params.get("s") ?? "").slice(0, 32);
  const token = (params.get("t") ?? "").slice(0, 64);
  return offersTokenOk(sid, token) ? { sid, token } : null;
}

/**
 * The studio's way to stop, for a creator whose link is lost or broken (no reply to be handled by hand): signed in, the
 * same page shows a button that stops them for every store on the account, and for a store made later
 * (offersStoppedForStore). Only this path reads a session, so only it is limited per connection; the signed link
 * above never is (RFC 8058: one-click presses come from a mail provider's few addresses).
 */
export const OFFERS_STUDIO_PER_HOUR = 30;

const NOT_RECOGNIZED = page(
  "Link not recognized",
  `<h1>Link not recognized</h1><p>This link is not one we recognize. You can stop these offers from your studio instead: <a href="/api/store/offers?via=studio">stop offers while signed in</a>.</p>`,
  400,
);

function notRecognized(): Response {
  return NOT_RECOGNIZED.clone();
}

/** Whose session this is, read exactly (CX-123 rule 24): null when signed out, "unknown" when the answer is not exact. */
async function signedInEmail(request: NextRequest): Promise<string | null | "unknown"> {
  try {
    return await sessionEmail(request.cookies.get(SESSION_COOKIE)?.value);
  } catch (error) {
    console.error("reading a session for the offers stop could not be confirmed", error);
    return "unknown";
  }
}

const STUDIO_ACTION = "/api/store/offers?via=studio";
const SIGN_IN_FIRST = `<h1>Sign in first</h1><p><a href="/signin">Sign in to your studio</a>, then open this page again to stop offers from Marktmorgen.</p>`;
const TRY_LATER = "<h1>Try again later</h1><p>Too many requests from here in the last hour. Please try again later.</p>";

async function studioGet(request: NextRequest): Promise<Response> {
  if (!(await withinLimit("offers-studio", clientAddress(request), OFFERS_STUDIO_PER_HOUR, 3_600).catch(() => false))) {
    return page("Try again later", TRY_LATER, 429);
  }
  const email = await signedInEmail(request);
  if (email === "unknown") return notConfirmed();
  if (!email) return page("Sign in first", SIGN_IN_FIRST);
  return page(
    "Offers from Marktmorgen",
    `<h1>Offers from Marktmorgen</h1><p>We sometimes email you an offer about your own plan, such as paying yearly. This stops them for every store on your account. Emails about your account, your sales and your payments still come.</p><form method="post" action="${esc(STUDIO_ACTION)}"><button>Stop these offers</button></form>`,
  );
}

async function studioPost(request: NextRequest): Promise<Response> {
  // A press of the studio's button only: another site cannot use a creator's session to press it.
  if (fromAnotherSite(request)) return page("Not from here", "<h1>Not from here</h1><p>To stop offers, use the button on this page while signed in to your studio.</p>", 403);
  if (!(await withinLimit("offers-studio", clientAddress(request), OFFERS_STUDIO_PER_HOUR, 3_600).catch(() => false))) {
    return page("Try again later", TRY_LATER, 429);
  }
  const email = await signedInEmail(request);
  if (email === "unknown") return notConfirmed();
  if (!email) return page("Sign in first", SIGN_IN_FIRST, 401);
  try {
    await stopOffersForAccount(email);
  } catch (error) {
    console.error("stopping an account's offers could not be confirmed", error);
    return notConfirmed();
  }
  return page("Stopped", "<h1>Stopped</h1><p>You will not get offers from Marktmorgen anymore, for any store on your account. Emails about your account, your sales and your payments still come.</p>");
}

/** Said when a read or the stop could not be confirmed (CX-123 rule 24): never "Stopped" or "Sign in first" on an unknown answer. */
function notConfirmed(): Response {
  return page("Not changed yet", "<h1>Not changed yet</h1><p>We could not confirm that these offers stopped just now. Please press the button again in a minute.</p>", 503);
}

async function stopped(sid: string): Promise<Response> {
  try {
    await stopOffers(sid);
  } catch (error) {
    // Said only once confirmed (CX-123 rule 24): never "Stopped" on an unknown answer.
    console.error("stopping a creator's offers could not be confirmed", error);
    return notConfirmed();
  }
  return page("Stopped", "<h1>Stopped</h1><p>You will not get offers from Marktmorgen anymore. Emails about your account, your sales and your payments still come.</p>");
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("via") === "studio") return studioGet(request);
  // The token is checked first, by CPU only: a link that is not one is refused without reading anything stored.
  const asked = read(request);
  if (!asked) return notRecognized();
  const action = `/api/store/offers?s=${encodeURIComponent(asked.sid)}&t=${encodeURIComponent(asked.token)}`;
  return page(
    "Offers from Marktmorgen",
    `<h1>Offers from Marktmorgen</h1><p>We sometimes email you an offer about your own plan, such as paying yearly. Emails about your account, your sales and your payments still come.</p><form method="post" action="${esc(action)}"><button>Stop these offers</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  if (request.nextUrl.searchParams.get("via") === "studio") return studioPost(request);
  // A mail app's one-click POST (RFC 8058) or the button: the token first, by CPU only, and no limit per connection.
  // A POST only ever stops: there is no way to start the offers again from here, from this site or another.
  const asked = read(request);
  if (!asked) return notRecognized();
  return stopped(asked.sid);
}
