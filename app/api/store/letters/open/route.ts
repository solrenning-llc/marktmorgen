import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { mintPass, passCookie, storeKey } from "@/lib/learn";
import { readLetterGrant, spendLetterOpen } from "@/lib/letter-access";
import { letterWords } from "@/lib/buyer-words/letters";
import { restingAway, takeBuyerRead } from "@/lib/buyer-actions";

/** The browser's first language, as a store language code ("es" from "es-MX,es;q=0.9"); the default when it names none of them. */
function browserLanguage(request: NextRequest): string {
  return (request.headers.get("accept-language") ?? "").split(",")[0].trim().slice(0, 2).toLowerCase();
}

/**
 * The link from the email. Whoever holds it has read that inbox, so this
 * browser is given the store's pass, as the community's link gives it
 * (lib/learn.ts): the email, and whatever else the address holds here, open
 * on it for 90 days, each still asked about on every page.
 *
 * The link is only read first; the store it names counts this as one of its
 * public requests before the link's open is spent, and a token that is not
 * a link writes nothing.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const grant = await readLetterGrant(token);
  const store = grant ? await storeForHandle(grant.h) : null;
  const gone = (language: unknown) =>
    new Response(letterWords(language).linkGone, {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (!grant || !store || storeKey(store) !== grant.k) return gone(browserLanguage(request));
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return restingAway(origin, store);
  // The link's count of opens read only in its exact shape (CX-123 rule 24): an unknown count lets no browser in, and
  // the buyer is told in the store's words to try again, never shown a bare server error.
  let spent: boolean;
  try {
    spent = await spendLetterOpen(token);
  } catch (error) {
    console.error("counting an emailed link's opens failed", error);
    return new Response(letterWords(store.language).linkBusy, {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
  if (!spent) return gone(store.language);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({ Location: `${origin}/@${store.handle}/letters/${grant.l}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
