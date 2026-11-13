/**
 * Closing a store deletes its custom domain's key only while the key is still this store's (#4109). Store B once
 * connected x.com and its hold lapsed; store A connected x.com and proved it (nl:domain:x.com = "a"). When B's plan
 * ends, B's closing (lib/closed-store-data.ts prepareStore) must not delete A's key, or A's domain stops serving A.
 * A key that still names B, proven ("b") or not ("?b"), or one of B's earlier addresses, is still deleted.
 * Synthetic only: the in-memory Redis stand-in, nothing real reached.
 */
import { prepareStore } from "@/lib/closed-store-data";
import { domainKey } from "@/lib/domains";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function closing(email: string, handle: string, domain: string, holder: string | null): Promise<unknown> {
  if (!(await claimHandle(email, handle, `Store ${handle}`, "")).ok) throw new Error("setup");
  await ensureStatsId(email);
  const store = { ...((await storeForEmail(email)) as Store), domain: { name: domain } } as Store;
  if (holder !== null) await redis.pipeline([["SET", domainKey(domain), holder]]);
  await prepareStore(store);
  return (await redis.pipeline([["GET", domainKey(domain)]]))[0];
}

async function main(): Promise<void> {
  redis.clear();
  const quiet = console.error;
  console.error = () => {};

  part("Another store's proven domain survives this store's closing (#4109)");
  is("x.com, proven by store a, is still store a's", await closing("b@example.com", "closingb", "x.example.com", "closinga"), "closinga");

  part("Another store's unproven claim survives it too");
  is("y.com, claimed by store a, is still store a's claim", await closing("c@example.com", "closingc", "y.example.com", "?closinga"), "?closinga");

  part("Control: this store's own domain goes with it");
  is("proven by the closing store: deleted", await closing("d@example.com", "closingd", "z.example.com", "closingd"), null);
  is("claimed, unproven, by the closing store: deleted", await closing("e@example.com", "closinge", "w.example.com", "?closinge"), null);
  is("no key at all: nothing to delete, nothing written", await closing("f@example.com", "closingf", "v.example.com", null), null);

  console.error = quiet;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
