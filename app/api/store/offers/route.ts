import type { NextRequest } from "next/server";
import { offersTokenOk, stopOffers } from "@/lib/offer-stop";

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

export async function GET(request: NextRequest) {
  const asked = read(request);
  if (!asked) return page("Link not recognized", "<h1>Link not recognized</h1><p>This link is not one we recognize. You can also stop these emails by replying to one of them.</p>", 400);
  const action = `/api/store/offers?s=${encodeURIComponent(asked.sid)}&t=${encodeURIComponent(asked.token)}`;
  return page(
    "Offers from Marktmorgen",
    `<h1>Offers from Marktmorgen</h1><p>We sometimes email you an offer about your own plan, such as paying yearly. Emails about your account, your sales and your payments still come.</p><form method="post" action="${esc(action)}"><button>Stop these offers</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const asked = read(request);
  if (!asked) return page("Link not recognized", "<h1>Link not recognized</h1><p>This link is not one we recognize.</p>", 400);
  try {
    await stopOffers(asked.sid);
  } catch (error) {
    // Said only once confirmed (CX-123 rule 24): never "Stopped" on an unknown answer.
    console.error("stopping a creator's offers could not be confirmed", error);
    return page("Not changed yet", "<h1>Not changed yet</h1><p>We could not confirm that these offers stopped just now. Please press the button again in a minute.</p>", 503);
  }
  return page("Stopped", "<h1>Stopped</h1><p>You will not get offers from Marktmorgen anymore. Emails about your account, your sales and your payments still come.</p>");
}
