/**
 * Counting from inside a request: who is asking, and whether it is the
 * creator looking at their own store, which is never counted.
 */
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { type HitKind, isBot, recordHit } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { affiliateCookieName, recordClick } from "@/lib/affiliates";
import { recordVisit } from "@/lib/traffic";
import { countryOf, deviceOf } from "@/lib/source-rules";
import { channelOfRequest } from "@/lib/visit-channel";
import { requestHost } from "@/lib/request-origin";
import { maybeBusyAlert } from "@/lib/stats-report";
import { readTeamMembers } from "@/lib/team";
import { NO_COUNT_COOKIE, isMarkedDevice } from "@/lib/no-count";

export function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** What is read off a request to know who is asking: a route's request, or a page's cookies and headers. */
type Asker = { cookies: { get(name: string): { value: string } | undefined }; headers: { get(name: string): string | null } };

/**
 * Whether this is the store's own people (isOwner, below), for a page that
 * counts something itself. Never throws: a sign-in or team that cannot be read
 * is not known, so it answers yes and that one count is skipped, never taken
 * for a buyer's (rule 24).
 */
export async function isStorePeople(request: Asker, store: Store): Promise<boolean> {
  return isOwner(request, store).catch((error) => {
    console.error("whether a visit is the store's own people is unknown; not counted", error);
    return true;
  });
}

/** The same, for a gate (lib/agreements: the store's own people can't sign): an unknown reading throws, never "not them". */
export async function isStorePeopleExact(request: Asker, store: Store): Promise<boolean> {
  return isOwner(request, store);
}

/**
 * Whether a visit is the store's own people looking at it (widened on 11
 * October 2026, as Fathom's "Remove Unwanted Visits" and Plausible's "exclude
 * your own visits" do): the owner signed in, anybody on the store's team
 * signed in, or a device the creator marked in the studio as not to be
 * counted (lib/no-count.ts). Each of them inflated the visitors and made the
 * share that buys look worse than it is. A buyer carries none of these, so
 * their visit costs nothing more to read. A sign-in or a team that cannot be
 * read throws (rule 24): unknown is never "not the store's people", so the
 * count is skipped, never taken for a buyer's.
 */
async function isOwner(request: Asker, store: Store): Promise<boolean> {
  if (isMarkedDevice(request.cookies.get(NO_COUNT_COOKIE)?.value, store.sid)) return true;
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return false;
  const email = (await emailForSession(session))?.toLowerCase();
  if (!email) return false;
  if (email === store.email.toLowerCase()) return true;
  if (!store.sid) return false;
  const members = await readTeamMembers(store.sid);
  return members.some((m) => m.email.toLowerCase() === email);
}

/**
 * Counts one visit, checkout or link, unless it is the owner's own. Never
 * throws: a count that fails must not stop a sale or a page.
 */
export async function countHit(
  request: NextRequest,
  store: Store,
  hit: { kind: HitKind; id?: string; source?: string; medium?: string; campaign?: string; free?: boolean },
): Promise<void> {
  try {
    if (await isOwner(request, store)) return;
    const userAgent = request.headers.get("user-agent") ?? "";
    const today = await recordHit(store, {
      ...hit,
      ip: clientIp(request),
      userAgent,
      // A view says where and on what (lib/stats.ts); a checkout says which
      // channel it came from, read the way the sale itself is credited.
      ...(hit.kind === "view" ? { country: countryOf(request.headers.get("x-vercel-ip-country")), device: deviceOf(userAgent) } : {}),
      ...(hit.kind === "checkout" || hit.kind === "signup"
        ? { channel: channelOfRequest(request, store.handle, requestHost(request), Date.now() / 1000, store.attributionDays).channel }
        : {}),
    });
    // Asked only at 64, 128, 256… views in a day, so a visit costs nothing more.
    if (today) await maybeBusyAlert(store, today);
  } catch (error) {
    console.error("counting a visit failed", error);
  }
}

/**
 * Counts a visit to the store toward the visits its plan covers
 * (lib/traffic.ts): one for each person each day, whichever of its pages
 * they open. Never the owner's own, and never a robot's that says it is
 * one. Never throws, like countHit.
 */
export async function countVisit(request: NextRequest, store: Store): Promise<void> {
  try {
    if (isBot(request.headers.get("user-agent") ?? "") || (await isOwner(request, store))) return;
    await recordVisit(store, clientIp(request));
  } catch (error) {
    console.error("counting a visit toward the plan failed", error);
  }
}

/**
 * Counts a click on an affiliate's link, unless it is the creator's own or a
 * robot's (lib/affiliates.ts does the rest). Never throws, like countHit.
 */
export async function countAffiliateClick(request: NextRequest, store: Store, code: string, paid = false): Promise<void> {
  try {
    const userAgent = request.headers.get("user-agent") ?? "";
    if (isBot(userAgent) || (await isOwner(request, store))) return;
    await recordClick(store, code, {
      ip: clientIp(request),
      userAgent,
      session: request.cookies.get(affiliateCookieName(store.handle))?.value,
      paid,
    });
  } catch (error) {
    console.error("counting an affiliate click failed", error);
  }
}
