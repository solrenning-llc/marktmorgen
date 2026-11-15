import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { type ExactStore, storeForHandleExactly } from "@/lib/store-exact";
import { mintPass, passCookie, storeKey } from "@/lib/learn";
import { readLetterGrant, spendLetterOpen } from "@/lib/letter-access";
import { letterWords } from "@/lib/buyer-words/letters";
import { OPEN_LINK_REQUEST_UNITS, restingAway, takeBuyerRead } from "@/lib/buyer-actions";
import { fromAnotherSite, limited } from "@/lib/request-guard";

/** The browser's first language, as a store language code ("es" from "es-MX,es;q=0.9"); the default when it names none of them. */
function browserLanguage(request: NextRequest): string {
  return (request.headers.get("accept-language") ?? "").split(",")[0].trim().slice(0, 2).toLowerCase();
}

/** A read that did not come back whole: nothing changed, try again shortly, in the language given (rule 24). */
const busyFor = (language: unknown) =>
  new Response(letterWords(language).linkBusy, {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "30" },
  });

/**
 * The link from the email. A GET spends nothing and gives no pass (MM-SA-53,
 * as MM-SA-41 for the community's and courses' links): mail filters and link
 * previews fetch every link in a message, and a GET that spent an open would
 * use the link up before the buyer tapped it, while a GET from another site
 * would make this browser act as the link's owner. It reads the link only
 * (one command) and sends the browser to the store's page that asks for one
 * tap (app/[handle]/letters/open/page.tsx).
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const token = request.nextUrl.searchParams.get("token") ?? "";
  let grant: Awaited<ReturnType<typeof readLetterGrant>>;
  try {
    grant = await readLetterGrant(token);
  } catch (error) {
    console.error("reading an emailed link's grant failed", error);
    return busyFor(browserLanguage(request));
  }
  if (!grant) {
    return new Response(letterWords(browserLanguage(request)).linkGone, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 303, headers: { Location: `${origin}/@${grant.h}/letters/open?token=${token}`, "Cache-Control": "no-store" } });
}

/**
 * The tap on that page. Whoever holds the link has read that inbox, so this
 * browser is given the store's pass, as the community's link gives it
 * (lib/learn.ts): the email, and whatever else the address holds here, open
 * on it for 90 days, each still asked about on every page. Only from this
 * site: a form on another site is refused before anything is read.
 *
 * The link is only read first; the store it names counts this as its public
 * requests before the link's open is spent, and a token that is not a link
 * writes nothing.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  const origin = originFrom(request);
  let token = "";
  try {
    const value = (await (await limited(request, 1_000)).formData()).get("token");
    token = typeof value === "string" ? value.slice(0, 80) : "";
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const busy = busyFor;
  let grant: Awaited<ReturnType<typeof readLetterGrant>>;
  try {
    grant = await readLetterGrant(token);
  } catch (error) {
    console.error("reading an emailed link's grant failed", error);
    return busy(browserLanguage(request));
  }
  let found: ExactStore | null = null;
  try {
    found = grant ? await storeForHandleExactly(grant.h) : null;
  } catch (error) {
    console.error("reading the store of an emailed link failed", error);
    return busy(browserLanguage(request));
  }
  if (found === "unknown") return busy(browserLanguage(request));
  const store = found === "none" ? null : found;
  const gone = (language: unknown) =>
    new Response(letterWords(language).linkGone, {
      status: 410,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  if (!grant || !store || storeKey(store) !== grant.k) return gone(browserLanguage(request));
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  // The store's public requests on the buyers' side (lib/buyer-actions.ts): two, for the GET and the page before it.
  if (!(await takeBuyerRead(store, OPEN_LINK_REQUEST_UNITS))) return restingAway(origin, store);
  // The link's count of opens read only in its exact shape (CX-123 rule 24): an unknown count lets no browser in, and
  // the buyer is told in the store's words to try again, never shown a bare server error.
  let spent: boolean;
  try {
    spent = await spendLetterOpen(token);
  } catch (error) {
    console.error("counting an emailed link's opens failed", error);
    return busy(store.language);
  }
  if (!spent) return gone(store.language);
  const pass = await mintPass(store, grant.e, "all");
  const headers = new Headers({ Location: `${origin}/@${store.handle}/letters/${grant.l}`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", passCookie(store, pass, origin.startsWith("https://")));
  return new Response(null, { status: 303, headers });
}
