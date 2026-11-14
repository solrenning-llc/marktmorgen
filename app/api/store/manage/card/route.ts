import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { CARD_TOKEN_PATTERN, finishCardUpdate, openCardUpdate } from "@/lib/card-update";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";

const MAX_BODY_BYTES = 1_000;

function away(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

/**
 * The button on the page the card email links to (lib/card-update.ts): a
 * Stripe page that saves a new card for that one membership. Guarded as the
 * buttons beside it are: refused from another site, read with a size limit,
 * counted per connection. Only a press does anything.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let token = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 80);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const page = (status: string) => `${origin}/@${store.handle}/manage/card?${CARD_TOKEN_PATTERN.test(token) ? `t=${token}&` : ""}status=${status}`;
  if (!CARD_TOKEN_PATTERN.test(token)) return away(page("expired"));
  // Past the limit, or a count that could not be read (unknown, rule 24): the page's own "try again in a moment".
  if ((await withinStore("manage-card", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit)) !== true) return away(page("error"));

  const result = await openCardUpdate(store, token, linkOrigin(request, store));
  return away(result.ok ? result.url : page(result.reason));
}

/**
 * Where Stripe sends the member back to once the card is saved: the card is
 * set on the membership, and a payment that already failed is paid with it.
 * Stripe's own page is the only way here with a finished session of this
 * store, and doing it twice changes nothing more.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle(params.get("handle") ?? "");
  const token = (params.get("t") ?? "").slice(0, 80);
  const session = (params.get("session_id") ?? "").slice(0, 300);
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });
  if ((await withinStore("manage-card-back", `${clientAddress(request)}|${store.handle}`, 30, 600, store, "buyer").catch(unknownLimit)) !== true) {
    return away(`${origin}/@${store.handle}/manage/card?${CARD_TOKEN_PATTERN.test(token) ? `t=${token}&` : ""}status=error`);
  }
  const status = await finishCardUpdate(store, session);
  return away(`${origin}/@${store.handle}/manage/card?${CARD_TOKEN_PATTERN.test(token) ? `t=${token}&` : ""}status=${status}`);
}
