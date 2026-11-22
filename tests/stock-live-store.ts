/**
 * A synthetic store for lib/stock.ts's tests, live as lib/live-fence.ts reads it (Codex L-20261120-0655): since then a
 * checkout's own hold is written only while its store's id key still holds the store's ref and nothing marks the store
 * erasing, in the same step (STOCK_BIND). A test's store made of a few fields has neither, so it is given an id and an
 * address here, and its id key is written in the Redis stand-in. keepLive writes that key again, for a test that starts
 * over from an empty stand-in (redis.clear()). The erasure itself is tested on a real store
 * (tests/stock-bind-after-erasure.test.ts). Synthetic only.
 */
import { type Store, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";

/** Writes the id key of `store` again, holding its ref: it is live. */
export function keepLive(store: Pick<Store, "sid" | "email" | "extra">): void {
  redis.run(["SET", storeIdCommand(store.sid)[1], storeRef(store)]);
}

/** `store` with an id (`sid`, 32 hex characters) and an address, its id key written: live. */
export function liveStockStore<T extends object>(store: T, sid: string, email: string): T & { sid: string; email: string } {
  const live = { ...store, sid, email };
  keepLive(live as unknown as Store);
  return live;
}
