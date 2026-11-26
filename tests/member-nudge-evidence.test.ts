import { nudgeStore } from "@/lib/member-nudge";
import type { Store } from "@/lib/store";
import { createHash } from "node:crypto";
import { afterTokens, failCount, memory, reset, sent } from "./member-nudge-world";
import { done, is, part } from "./check";

const store = {
  name: "Supper Club", handle: "club", email: "club@example.com", language: "en",
  stripeAccountId: "acct_1TestClub000001", statsId: "statsclub", listId: "listclub",
  nudge: { on: true, address: "Synthetic postal address" },
} as unknown as Store;
const key = "nl:nudge:statsclub:sub_Member000001:2000000000";
const now = Date.UTC(2026, 10, 5);
// What suppressCommand("listclub", "member@example.com", seconds) writes (lib/suppression.ts), built here because
// importing lib/suppression in the test pulls lib/auth through the stand-in world.
const erasureMark = () => ["HSET", "nl:erased:listclub", createHash("sha256").update("nimbus-erased:listclub:member@example.com").digest("hex").slice(0, 32), Math.floor(Date.now() / 1000)];

async function main(): Promise<void> {
  part("A member notice needs exact ownership of its per-period mark");
  for (const [name, reply] of [
    ["empty reply", []], ["missing reply", undefined], ["null reply", null],
    ["missing acknowledgement", [undefined]], ["boolean acknowledgement", [false]],
    ["text acknowledgement", ["OK"]], ["numeric text", ["1"]], ["unknown number", [2]], ["unknown acknowledgement", ["QUEUED"]],
    ["extra result", [1, 1]], ["extra result after no claim", [0, 1]],
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
  reset([0]);
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

  part("A token held in memory does not authorize a notice after erasure (#4764, Codex L)");
  reset();
  afterTokens(async () => { await memory.pipeline([erasureMark()]); });
  is("the erased member gets no notice", [await nudgeStore(store, Date.now() + 60_000, now), sent], [0, 0]);
  is("no period claim or monthly count is written for the erased recipient", memory.keys().filter((k) => k.startsWith("nl:nudge:")), []);
  reset([-1]);
  is("a refusal for an erasure sends nothing and claims nothing", [await nudgeStore(store, Date.now() + 60_000, now), sent], [0, 0]);
  is("a refusal for an erasure counts nothing", memory.keys().some((k) => k.startsWith("nl:nudge:count:")), false);
}

void main().then(done).catch(error => { console.error(error); process.exit(1); });
