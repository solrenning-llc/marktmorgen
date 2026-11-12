/**
 * Closing a store lets go of its custom domain only while that domain is still its own (#4109; found in the
 * Claude 1 cloud audit of routing and custom domains).
 *
 * prepareStore (lib/closed-store-data.ts) deleted nl:domain:<name> for any domain named on the closing store's
 * record, unconditionally. The record keeps its domain after a claim lapsed and another store took and proved it,
 * so closing the first store deleted the second store's key and its custom domain stopped serving it until its
 * owner pressed "check". Now the key goes only while it holds this store's own claim, proved ("handle") or not
 * ("?handle"), under any of its handles, in one compare-and-delete each; an answer that cannot be read throws, so
 * the walk tries the store again.
 *
 * Synthetic stores against the in-memory Redis; nothing real is reached.
 */
import { prepareStore } from "@/lib/closed-store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const domainOf = async (name: string) => (await redis.pipeline([["GET", `nl:domain:${name}`]]))[0];

async function closingStore(owner: string, handle: string, domain: string): Promise<Store> {
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  return { ...store, domain: { name: domain, addedAt: new Date().toISOString(), liveAt: "" } };
}

async function main(): Promise<void> {
  redis.clear();

  part("Another store took the domain and proved it: closing this one leaves it alone");
  const late = await closingStore("late@example.com", "latestore", "shop.example.com");
  await redis.pipeline([["SET", "nl:domain:shop.example.com", "realowner"]]);
  await prepareStore(late);
  is("the other store's proved domain is kept", await domainOf("shop.example.com"), "realowner");

  part("Another store holds an unproved claim: kept too");
  const other = await closingStore("other@example.com", "otherstore", "two.example.com");
  await redis.pipeline([["SET", "nl:domain:two.example.com", "?someoneelse", "EX", 3600]]);
  await prepareStore(other);
  is("their claim is kept", await domainOf("two.example.com"), "?someoneelse");

  part("Control: the store's own domain goes with it, proved or not");
  const own = await closingStore("own@example.com", "ownstore", "own.example.com");
  await redis.pipeline([["SET", "nl:domain:own.example.com", "ownstore"]]);
  await prepareStore(own);
  is("its proved domain is let go", await domainOf("own.example.com"), null);
  const pending = await closingStore("pending@example.com", "pendingstore", "pend.example.com");
  await redis.pipeline([["SET", "nl:domain:pend.example.com", "?pendingstore", "EX", 3600]]);
  await prepareStore(pending);
  is("its unproved claim is let go", await domainOf("pend.example.com"), null);

  part("Control: held under an older handle of the same store, it still goes");
  const renamed = await closingStore("renamed@example.com", "newname", "old.example.com");
  await redis.pipeline([["SET", "nl:domain:old.example.com", "oldname"]]);
  await prepareStore({ ...renamed, previousHandles: ["oldname"] });
  is("let go", await domainOf("old.example.com"), null);

  done();
}

main();
