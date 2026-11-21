/**
 * A store's reading slot is kept until a page asks for its token, whatever other pages of the store are checked in
 * between (Claude 5's second review of #2571, LOW 3): page A's check draws the slot, page B's check (not a slot) runs
 * before A asks, and A still gets its token; two slots drawn before either asks give two tokens, never more. No
 * command; no outside request.
 */
import { allowanceWindow } from "@/lib/allowance-window";
import { noteReadStore, readSampled, readSlot, readToken } from "@/lib/page-read";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const STATS = "statsslot01";
const store = { tier: "creator" as const, subscriptionActive: true, periodStart: Math.floor(Date.now() / 1000) - 86_400, periodEnd: Math.floor(Date.now() / 1000) + 20 * 86_400 };
let seed = 0;
const drawn = () => {
  for (;;) {
    const n = `visit${String((seed += 1)).padStart(11, "0")}`;
    if (readSampled(n)) return n;
  }
};

function main(): void {
  const now = Date.now();
  const window = allowanceWindow(store as never, now);
  is("(the store has a window)", Boolean(window), true);
  const id = window!.id;
  let place = 0;
  const slot = () => {
    do place += 1;
    while (!readSlot(id, place));
    return place;
  };
  const notSlot = () => {
    do place += 1;
    while (readSlot(id, place));
    return place;
  };

  part("Another page of the store is checked between A's check and A's token");
  noteReadStore(STATS, store as never, now, slot());
  noteReadStore(STATS, store as never, now, notSlot());
  is("A still gets its token", readToken(STATS, "prod000001", now, drawn()) !== "", true);
  is("and only one for its slot", readToken(STATS, "prod000001", now, drawn()), "");

  part("Two slots drawn before either page asks");
  noteReadStore(STATS, store as never, now, slot());
  noteReadStore(STATS, store as never, now, slot());
  is("two tokens", [readToken(STATS, "prod000001", now, drawn()) !== "", readToken(STATS, "prod000001", now, drawn()) !== ""], [true, true]);
  is("and no third", readToken(STATS, "prod000001", now, drawn()), "");

  part("A store found resting forgets what was kept");
  noteReadStore(STATS, store as never, now, slot());
  noteReadStore(STATS, null, now, 0);
  is("no token", readToken(STATS, "prod000001", now, drawn()), "");
  done();
}
main();
