/**
 * Counting from inside a request: who is asking, and whether it is the
 * creator looking at their own store, which is never counted.
 */
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, emailForSession } from "@/lib/auth";
import { type HitKind, isBot, recordHit } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { affiliateCookieName, recordClick } from "@/lib/affiliates";
import { markCountGap, recordVisit } from "@/lib/traffic";
import { countryOf, deviceOf } from "@/lib/source-rules";
import { channelOfRequest } from "@/lib/visit-channel";
import { requestHost } from "@/lib/request-origin";
import { maybeBusyAlert } from "@/lib/stats-report";
import { readTeam } from "@/lib/team";
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

/** Whether this is the store's own people (isOwner, below), for a page that counts something itself. Never throws. */
export async function isStorePeople(request: Asker, store: Store): Promise<boolean> {
  return isOwner(request, store).catch(() => false);
}

/**
 * Whether a visit is the store's own people looking at it (widened on 11
 * October 2026, as Fathom's "Remove Unwanted Visits" and Plausible's "exclude
 * your own visits" do): the owner signed in, anybody on the store's team
 * signed in, or a device the creator marked in the studio as not to be
 * counted (lib/no-count.ts). Each of them inflated the visitors and made the
 * share that buys look worse than it is. A buyer carries none of these, so
 * their visit costs nothing more to read.
 */
async function isOwner(request: Asker, store: Store): Promise<boolean> {
  if (isMarkedDevice(request.cookies.get(NO_COUNT_COOKIE)?.value, store.sid)) return true;
  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) return false;
  const email = (await emailForSession(session).catch(() => null))?.toLowerCase();
  if (!email) return false;
  if (email === store.email.toLowerCase()) return true;
  if (!store.sid) return false;
  const team = await readTeam(store.sid).catch(() => null);
  return Boolean(team?.members.some((m) => m.email.toLowerCase() === email));
}

/**
 * Counts one visit, checkout or link, unless it is the owner's own. Never
 * throws: a count that fails must not stop a sale or a page.
 */
export async function countHit(
  request: NextRequest,
  store: Store,
  hit: { kind: HitKind; id?: string; source?: string; medium?: string; campaign?: string; free?: boolean },
  /**
   * Asked once the store's own people are known not to be the ones looking,
   * with what the count writes: a signal that is not a page takes its place
   * in the store's window around it (lib/traffic.ts, takeSignal), so the owner
   * and the store's team never spend one, and nothing is written once the
   * window's are spent.
   */
  signal?: (write: () => Promise<boolean>) => Promise<boolean>,
): Promise<void> {
  try {
    if (await isOwner(request, store)) return;
    const userAgent = request.headers.get("user-agent") ?? "";
    let today: number | null = null;
    const write = async () => {
      today = await recordHit(store, {
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
      return true;
    };
    if (signal) {
      if (!(await signal(write))) return;
    } else await write();
    // Asked only at 64, 128, 256… views in a day: the fortnight before is read
    // once a day per store, and each later power of two costs a few commands
    // (lib/stats-report.ts, maybeBusyAlert; priced in tests/traffic-cost.ts).
    if (today) await maybeBusyAlert(store, today);
  } catch (error) {
    console.error("counting a visit failed", error);
    // A count not made is written down, so no rate is shown from it (lib/traffic.ts, markCountGap).
    await markCountGap(store.handle);
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
export async function countAffiliateClick(
  request: NextRequest,
  store: Store,
  code: string,
  paid = false,
  /** As countHit's: the click's signal is kept only when recordClick wrote it (an approved code, new today, under the address's limit). */
  signal?: (write: () => Promise<boolean>) => Promise<boolean>,
): Promise<void> {
  try {
    const userAgent = request.headers.get("user-agent") ?? "";
    // A robot and the store's own people never spend the store's signals.
    if (isBot(userAgent) || (await isOwner(request, store))) return;
    const write = () =>
      recordClick(store, code, {
        ip: clientIp(request),
        userAgent,
        session: request.cookies.get(affiliateCookieName(store.handle))?.value,
        paid,
      });
    if (signal) await signal(write);
    else await write();
  } catch (error) {
    console.error("counting an affiliate click failed", error);
    await markCountGap(store.handle);
  }
}
