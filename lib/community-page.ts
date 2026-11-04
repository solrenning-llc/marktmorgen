/**
 * Who is opening a page of a community, and the day's visit that opening it
 * is (lib/day-visit.ts).
 *
 * Every page of a community asks this instead of communityViewer itself, so
 * that a member's day there counts toward the store's visits once, like a
 * day on any other page of the store. The routes those pages ask things of
 * keep to communityViewer: they are part of a visit and not another.
 */
import { type Viewer, communityViewer } from "@/lib/community-access";
import { countDay } from "@/lib/day-visit";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { countStudio } from "@/lib/studio-route";
import { redirect } from "next/navigation";
import type { Store } from "@/lib/store";

type CookieJar = Parameters<typeof communityViewer>[1];

/**
 * `units` of the store's window for a read a community page does past the
 * page itself (the search, lib/read-ceilings.ts), taken before it reads:
 * a member's from the buyers' requests, the creator's from the studio's.
 * `why` is what the studio's paused page is told when the creator's is refused.
 */
export async function takeCommunityRead(store: Store, owner: boolean, units: number): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!owner) return (await takePublicRequest(store, "buyer", Date.now(), units)) ? { ok: true } : { ok: false, why: "used" };
  const counted = await countStudio(store, null, units).catch(() => null);
  return counted?.ok ? { ok: true } : { ok: false, why: counted && !counted.ok ? counted.reason : "unknown" };
}

export async function communityVisitor(store: Store, cookies: CookieJar): Promise<Viewer> {
  const viewer = await communityViewer(store, cookies);
  // Somebody who is in, and is not the creator, whose own days are never counted.
  if (viewer.state === "in" && !viewer.owner) {
    // Once the whole month's visits are used, members' pages rest too (lib/traffic-rules.ts).
    if (await isResting(store, Date.now(), "buyer")) redirect(`/@${store.handle}/resting`);
    await countDay(store);
  }
  return viewer;
}
