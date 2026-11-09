/**
 * A paid order on the creator's list (added 11 October 2026): the buyer
 * joined when they ticked the box, what they bought noted against them, and
 * the sequences that start on it started.
 *
 * This was done by the thanks page alone, so a buyer who closed the tab while
 * Stripe was sending them there was confirmed by the five-minute job
 * (lib/checkout-sweep.ts) and never put on the list: no welcome, no emails
 * after the purchase, and a sequence meant to stop once they bought went on
 * selling them what they already had. Now both call this, and whichever gets
 * there first does it, once per checkout.
 *
 *   nl:listed:<checkout id>   done (kept 8 days), or being done (2 minutes, the claim's own value)
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { noteProduct, orderRoom, upsertContact } from "@/lib/contacts";
import { enroll } from "@/lib/flows";
import type { Store } from "@/lib/store";
import { personReturned } from "@/lib/crm";

const listedKey = (sessionId: string) => `nl:listed:${sessionId}`;
const DONE_SECONDS = 8 * 86_400;
const WORKING_SECONDS = 120;

export type ListedOrder = {
  sessionId: string;
  email: string;
  /** The buyer ticked the box to hear from the creator. */
  news: boolean;
  /** And the second box, allowing their link use in sequences to be seen (lib/mail-clicks.ts). */
  clicks?: boolean;
  /** When it was paid, in seconds. */
  created: number;
  /** What it handed over: the product bought first, then what came with it. */
  products: { id: string; title: string }[];
};

/**
 * Which of these checkouts are already on the list, in one round trip, read exactly (CX-123 rule 24, L7): true or
 * false only from one reply per checkout that is 1 or 0. Anything else is null, never "not on the list yet", so the
 * caller does nothing on it this run and says so.
 */
export async function listedAlready(sessionIds: string[]): Promise<(boolean | null)[]> {
  if (!sessionIds.length || !isRedisConfigured()) return sessionIds.map(() => false);
  let marks: unknown[] | null = null;
  try {
    marks = repliesFor(await redisPipeline(sessionIds.map((id) => ["EXISTS", listedKey(id)])), sessionIds.length);
  } catch {
    marks = null;
  }
  return sessionIds.map((_, i) => {
    const mark = marks ? countOf(marks[i]) : null;
    return mark === 1 ? true : mark === 0 ? false : null;
  });
}

/**
 * Puts one paid order on the list, unless it is there already. Somebody who
 * ticked the box joins (or is noted again), with every product; somebody who
 * did not is added to nothing, and only has the products noted if they are
 * on the list already. Each product starts its own sequences, as if bought
 * on its own. Never throws.
 */
export async function listOrder(store: Store, order: ListedOrder): Promise<"done" | "already" | "skip"> {
  const outcome = await putOnList(store, order);
  return outcome === "failed" ? "skip" : outcome;
}

/**
 * listOrder, saying apart what it could not do (Codex G on #2719): "failed" when the claim or a write was not known
 * to land, so a run counts it; "skip" only when there is nothing to do here. The checkout sweep reads this one.
 */
export async function putOnList(store: Store, order: ListedOrder): Promise<"done" | "already" | "skip" | "failed"> {
  if (!store.listId || !order.email || !order.products.length || !isRedisConfigured()) return "skip";
  const key = listedKey(order.sessionId);
  // This run's own claim (lib/claim-mark.ts): OK, or answered in another shape with our value read back. Taken by
  // another run, or there already: "already". Unknown: nothing is done now, and the next run asks again.
  const value = claimValue();
  const claimed = await claimMark(key, WORKING_SECONDS, value);
  if (claimed === "taken") return "already";
  // Not known whether the claim landed (Codex G on #2719): "failed", not "skip", so a run counts it.
  if (claimed === "unknown") return "failed";
  const products = order.products.filter((p, i) => order.products.findIndex((q) => q.id === p.id) === i);
  try {
    if (order.news) {
      const [first, ...rest] = products;
      const added = await upsertContact(store.listId, order.email, {
        agreed: true,
        explicit: true,
        at: new Date(order.created * 1000).toISOString(),
        source: "buyer",
        sid: store.sid,
        clicks: order.clicks === true,
        productId: first.id,
        title: first.title,
      }, orderRoom(store));
      await enroll(store, order.email, { joined: added.joined, productId: first.id });
      for (const item of rest) {
        if (await noteProduct(store.listId, order.email, item.id, item.title, store)) {
          await enroll(store, order.email, { joined: false, productId: item.id });
        }
      }
    } else {
      // Someone already on the list who buys without the box: nobody new is
      // added, but a sequence about what they bought starts for them.
      for (const got of products) {
        if (await noteProduct(store.listId, order.email, got.id, got.title, store)) {
          await enroll(store, order.email, { joined: false, productId: got.id });
        }
      }
    }
    // A paid order: they came back on their own, so the CRM may keep fields about them again (lib/crm.ts, personReturned; C3-125),
    // only if it was paid after they were deleted: one listed late is not a return (Codex D, #2287). Taken only once the
    // order is on the list, so a run that fails part way leaves the mark for the run that lists it.
    await personReturned(store.statsId, order.email, order.created * 1000);
    await redisPipeline([["SET", key, "done", "EX", DONE_SECONDS]]);
    return "done";
  } catch (error) {
    console.error("putting an order on the list failed", error);
    // Only our own claim is let go (Revisor 1 on #2719): one that ran out and was taken by another run stays its.
    await releaseMark(key, value);
    return "failed";
  }
}
