import { nudgeStore } from "@/lib/member-nudge";
import type { Store } from "@/lib/store";
import { failCount, memory, reset, sent } from "./member-nudge-world";
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

  part("An accepted notice keeps its period mark when the monthly count fails (Codex I2 / Claude 1 MEDIUM)");
  reset();
  failCount();
  let first: unknown;
  try { first = await nudgeStore(store, Date.now() + 60_000, now); } catch { first = "threw"; }
  is("the accepted notice is reported as sent", [first, sent], [1, 1]);
  is("the period mark stays after the count fails", memory.keys().includes(key), true);
  let second: unknown;
  try { second = await nudgeStore(store, Date.now() + 60_000, now); } catch { second = "threw"; }
  is("the next run sends nothing more in the same period", [second, sent], [0, 1]);
}

void main().then(done).catch(error => { console.error(error); process.exit(1); });
