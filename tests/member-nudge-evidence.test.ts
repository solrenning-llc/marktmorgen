import { nudgeStore } from "@/lib/member-nudge";
import type { Store } from "@/lib/store";
import { memory, reset, sent } from "./member-nudge-world";
import { done, is, part } from "./check";

const store = {
  name: "Supper Club", handle: "club", email: "club@example.com", language: "en",
  stripeAccountId: "acct_1TestClub000001", statsId: "statsclub", listId: "listclub",
  nudge: { on: true, address: "Synthetic postal address" },
} as unknown as Store;
const key = "nl:nudge:statsclub:sub_Member000001:2000000000";
const now = Date.UTC(2026, 10, 5);

async function main(): Promise<void> {
  part("A member notice needs exact ownership of its per-period mark");
  for (const [name, reply] of [
    ["empty reply", []], ["missing reply", undefined], ["null reply", null],
    ["missing acknowledgement", [undefined]], ["boolean acknowledgement", [false]],
    ["numeric acknowledgement", [1]], ["unknown acknowledgement", ["QUEUED"]],
    ["extra result", ["OK", "OK"]], ["extra result after no claim", [null, "OK"]],
  ] as const) {
    reset(reply);
    let outcome: unknown;
    try { outcome = await nudgeStore(store, Date.now() + 60_000, now); }
    catch { outcome = "unknown"; }
    is(`${name}: no unconfirmed notice is sent`, [outcome, sent], ["unknown", 0]);
    is(`${name}: an uncertain claim is retained`, memory.keys().includes(key), true);
    is(`${name}: no monthly delivery count is invented`, memory.keys().some(k => k.startsWith("nl:nudge:count:")), false);
  }

  part("Explicit refusals and successful ownership keep their meaning");
  reset([null]);
  is("a mark not acquired sends nothing", [await nudgeStore(store, Date.now() + 60_000, now), sent], [0, 0]);
  reset();
  is("a genuine first claim sends once", [await nudgeStore(store, Date.now() + 60_000, now), sent], [1, 1]);
  is("a genuine repeated claim sends nothing more", [await nudgeStore(store, Date.now() + 60_000, now), sent], [0, 1]);
  is("only the accepted notice is counted", await memory.pipeline([["GET", "nl:nudge:count:statsclub:2026-11"]]), ["1"]);
}

void main().then(done).catch(error => { console.error(error); process.exit(1); });
