/**
 * 119 [F2-FREE-RECOMMENDATIONS], unit 1: the other stores a creator
 * recommends on the page a new subscriber lands on after confirming
 * (app/[handle]/join/page.tsx, status "joined").
 *
 * Free on both sides: nobody pays to be recommended and nobody is paid. The
 * subscriber is never signed up anywhere else: the page shows each store's
 * name as a plain link to its own page, carrying nothing about them, and they
 * choose for themselves.
 *
 * Checked twice. When saved, every pick must be a store that exists, is not
 * suspended and is not the creator's own (checkRecommended). When the page is
 * drawn, the stores are read again and any gone, suspended or now the
 * creator's own is left out (readRecommended).
 *
 * Paid for before it reads: drawing the list reads one store record per pick,
 * so it takes that many of the recommending store's public requests first
 * (lib/traffic.ts, takePublicRequest), each priced as a page of the plan's
 * own window. Refused, nothing is read and nothing is shown; the page itself
 * still works.
 */
import { type Store, storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { MAX_RECOMMEND } from "@/lib/store-field-rules";

export type Recommended = { handle: string; name: string };

/** Whether a store may be recommended by `from`: it exists, is not suspended, and is not `from` itself. */
function recommendable(from: Pick<Store, "handle">, store: Store | null): store is Store {
  return store !== null && !store.suspended && store.handle !== from.handle;
}

/** Checks the creator's picks before they are saved: every one must be a real store other than their own. */
export async function checkRecommended(from: Store, handles: readonly string[], read: (handle: string) => Promise<Store | null> = storeForHandle): Promise<{ ok: true } | { ok: false; refused: string[] }> {
  const refused: string[] = [];
  for (const handle of handles.slice(0, MAX_RECOMMEND)) {
    if (handle === from.handle || !recommendable(from, await read(handle))) refused.push(handle);
  }
  return refused.length ? { ok: false, refused } : { ok: true };
}

/**
 * The stores to show, in the creator's order, after paying for their reads: one public request per pick, taken
 * from the recommending store before any is read. Refused, or with no picks, none is read.
 */
export async function readRecommended(
  from: Store,
  take: (store: Store, who: "public", now: undefined, units: number) => Promise<boolean> = (store, who, now, units) => takePublicRequest(store, who, now, units),
  read: (handle: string) => Promise<Store | null> = storeForHandle,
): Promise<Recommended[]> {
  const picks = from.join.recommend.slice(0, MAX_RECOMMEND).filter((handle) => handle !== from.handle);
  if (picks.length === 0) return [];
  if (!(await take(from, "public", undefined, picks.length))) return [];
  const shown: Recommended[] = [];
  for (const handle of picks) {
    const store = await read(handle).catch(() => null);
    if (recommendable(from, store)) shown.push({ handle: store.handle, name: store.name });
  }
  return shown;
}
