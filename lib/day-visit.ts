/**
 * A buyer's day on a store, counted as the visit it is.
 *
 * A store's public pages say they were opened themselves (components/
 * store-beacon.tsx). The pages a buyer comes back to do not: a course, a
 * lesson, the community. They are drawn for somebody the server already
 * knows, so the count is made here, on the server, as the page is drawn:
 * one visit for that address that day, the same one a public page of the
 * store would have counted (lib/traffic.ts), and so never a second one for
 * somebody who looked at the store's front page first.
 *
 * It is made after the page has been sent, so nobody waits on a count, and
 * it never throws. The creator is not counted: the callers leave them out.
 *
 * Only for a page. A route that answers a page's own questions (a like, a
 * message, the room asking what is new) is part of a visit and not another.
 */
import { headers } from "next/headers";
import { after } from "next/server";
import type { Store } from "@/lib/store";
import { recordVisit } from "@/lib/traffic";
import { forwardedAddress } from "@/lib/request-guard";

export async function countDay(store: Store): Promise<void> {
  try {
    // Read before the page is done: a page cannot read its request afterwards.
    const from = await headers();
    const ip = forwardedAddress(from);
    if (!ip) return;
    after(() => recordVisit(store, ip));
  } catch (error) {
    console.error("counting a buyer's day toward the plan failed", error);
  }
}
