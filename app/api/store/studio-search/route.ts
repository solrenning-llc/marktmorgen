import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { fromAnotherSite, limited, essentialLimitState } from "@/lib/request-guard";
import { STORE_COOKIE, countStudio, pinnedStore, refusedJson, resolveAccess } from "@/lib/studio-route";
import { STUDIO_SEARCH_UNITS } from "@/lib/studio-allowance-rules";
import { SEARCHES_PER_DAY, SEARCHES_PER_MINUTE, SEARCH_BODY_BYTES, cleanQuery, hasAt } from "@/lib/studio-search-rules";
import { studioSearch } from "@/lib/studio-search";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (error: string, status: number, message?: string) =>
  Response.json(message ? { ok: false, error, message } : { ok: false, error }, { status, headers: NO_STORE });

/**
 * The studio's one search box (766 [STN13], unit 1; components/studio-search.tsx):
 * POST { q } → the store's products, its own pages and the studio's tools that
 * match, each group only for a role that may open it (lib/studio-search.ts).
 *
 * A POST, so the words never sit in an address or a request log; nothing here
 * prints them, and a search is a reading, so nothing is written to the team's
 * log. In this order, before anything costs: a request from another site, a
 * body past SEARCH_BODY_BYTES and words that are no search (or hold an "@": a
 * buyer is opened by the studio's own look-up, app/api/store/person, never
 * here) are refused with no read. Then who and which store, as every studio
 * page settles it (lib/studio-route.ts), with no permission asked: what each
 * role sees is decided per group. Then the store's minute and day ceilings
 * are counted, each refused when full and when its count cannot be read, so a
 * refused search takes none of the store's studio requests. Then
 * STUDIO_SEARCH_UNITS of them are taken before anything is read, refused with
 * the allowance's own reason when they cannot be. Only then the one exact
 * read of the product names.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return refuse("forbidden", 403);
  let body: unknown;
  try {
    body = await (await limited(request, SEARCH_BODY_BYTES)).json();
  } catch {
    return refuse("invalid", 400);
  }
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).q : undefined;
  const query = cleanQuery(raw);
  if (!query || hasAt(query)) return refuse("query", 400);

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  const email = await emailForSession(session);
  if (!email) return refusedJson("signed_out");
  const resolved = await resolveAccess(email, { pinned: pinnedStore(request), remembered: request.cookies.get(STORE_COOKIE)?.value ?? null, session }, null);
  if (!resolved.ok) return refusedJson(resolved.reason);
  const { access } = resolved;

  const who = access.store.sid || access.store.handle;
  const minute = await essentialLimitState("studio-search", who, SEARCHES_PER_MINUTE, 60);
  if (minute === "exceeded") return refuse("slow", 429, "That is a lot of searches in one minute. Wait a minute, then search again.");
  if (minute === "unknown") return refuse("unknown", 503, "We could not search just now. Try again in a moment.");
  const day = await essentialLimitState("studio-search-day", who, SEARCHES_PER_DAY, 86_400);
  if (day === "exceeded") return refuse("day", 429, "Your store has used today's searches. You can search again tomorrow.");
  if (day === "unknown") return refuse("unknown", 503, "We could not search just now. Try again in a moment.");

  const counted = await countStudio(access.store, null, STUDIO_SEARCH_UNITS);
  if (!counted.ok) {
    if (counted.reason === "used") return refusedJson("used", counted.message);
    return refuse(counted.reason, counted.reason === "unknown" ? 503 : 429, counted.message);
  }
  const store = counted.store ?? access.store;

  try {
    const answer = await studioSearch(store, access.role, query);
    return Response.json({ ok: true, ...answer }, { headers: NO_STORE });
  } catch {
    return refuse("unknown", 503, "We could not search just now. Try again in a moment.");
  }
}
