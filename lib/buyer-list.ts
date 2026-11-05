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
 *   nl:listed:<checkout id>   done (kept 8 days), or being done (2 minutes)
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
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

/** Which of these checkouts are already on the list, in one round trip. */
export async function listedAlready(sessionIds: string[]): Promise<boolean[]> {
  if (!sessionIds.length || !isRedisConfigured()) return sessionIds.map(() => false);
  const marks = await redisPipeline(sessionIds.map((id) => ["EXISTS", listedKey(id)]));
  return marks.map((m) => Number(m) === 1);
}

/**
 * Puts one paid order on the list, unless it is there already. Somebody who
 * ticked the box joins (or is noted again), with every product; somebody who
 * did not is added to nothing, and only has the products noted if they are
 * on the list already. Each product starts its own sequences, as if bought
 * on its own. Never throws.
 */
export async function listOrder(store: Store, order: ListedOrder): Promise<"done" | "already" | "skip"> {
  if (!store.listId || !order.email || !order.products.length || !isRedisConfigured()) return "skip";
  const key = listedKey(order.sessionId);
  try {
    const [claimed] = await redisPipeline([["SET", key, "working", "NX", "EX", WORKING_SECONDS]]);
    if (claimed === null) return "already";
  } catch (error) {
    console.error("marking an order for the list failed", error);
    return "skip";
  }
  const products = order.products.filter((p, i) => order.products.findIndex((q) => q.id === p.id) === i);
  try {
    // A paid order: they came back on their own, so the CRM may keep fields about them again (lib/crm.ts, personReturned; C3-125),
    // only if it was paid after they were deleted: one listed late is not a return (Codex D, #2287).
    await personReturned(store.statsId, order.email, order.created * 1000);
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
    await redisPipeline([["SET", key, "done", "EX", DONE_SECONDS]]);
    return "done";
  } catch (error) {
    console.error("putting an order on the list failed", error);
    await redisPipeline([["DEL", key]]).catch(() => null);
    return "skip";
  }
}
