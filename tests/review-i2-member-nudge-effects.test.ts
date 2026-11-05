/** Independent review: real notice code/MemoryRedis, author's controlled consent/scoring/transport. */
import assert from "node:assert/strict";
import test from "node:test";
import { nudgeStore, nudgesThisMonth } from "@/lib/member-nudge";
import type { Store } from "@/lib/store";
import { memory, reset, sent } from "./member-nudge-world";

const store = { name: "Supper Club", handle: "club", email: "club@example.com", language: "en", stripeAccountId: "acct_1TestClub000001", statsId: "statsclub", listId: "listclub", nudge: { on: true, address: "Synthetic postal address" } } as unknown as Store;
const key = "nl:nudge:statsclub:sub_Member000001:2000000000";
const now = Date.UTC(2026, 10, 5);
const counter = "nl:nudge:count:statsclub:2026-11";

for (const applied of [false, true]) test("confirmed notice is not replayed after count acknowledgement loss, applied=" + applied, async () => {
  reset();
  const base = memory.pipeline.bind(memory); let faulted = false;
  memory.pipeline = async commands => {
    if (!faulted && commands[0]?.[0] === "INCR" && commands[0]?.[1] === counter) {
      faulted = true;
      if (applied) await base(commands);
      throw Error("Synthetic count acknowledgement unavailable after the sender accepted");
    }
    return base(commands);
  };
  try {
    let first: unknown;
    try { first = await nudgeStore(store, Date.now() + 60000, now); } catch { first = "unknown"; }
    const retainedAfterFirst = memory.keys().includes(key);
    const second = await nudgeStore(store, Date.now() + 60000, now);
    console.log(JSON.stringify({ applied, first, second, retainedAfterFirst, transportAcceptances: sent, counter: await base([["GET", counter]]) }));
    assert.equal(sent, 1, "a successful email cannot lose its per-period deduplication mark because bookkeeping failed");
    assert.equal(retainedAfterFirst, true);
  } finally { memory.pipeline = base; }
});

test("ordinary confirmed send retains its mark and repeats no notice", async () => {
  reset();
  assert.equal(await nudgeStore(store, Date.now() + 60000, now), 1);
  assert.equal(await nudgeStore(store, Date.now() + 60000, now), 0);
  assert.equal(sent, 1);
  assert.equal(memory.keys().includes(key), true);
  assert.deepEqual(await memory.pipeline([["GET", counter]]), ["1"]);
});

for (const [label, reply] of [
  ["missing slot", []], ["undefined slot", [undefined]], ["boolean", [false]],
  ["empty text", [""]], ["non-counter text", ["garbage"]], ["negative", ["-1"]],
  ["fraction", ["1.5"]], ["infinite", ["Infinity"]], ["extra result", ["2", "0"]],
] as const) test("unknown monthly notice evidence is not a known number: " + label, async () => {
  reset();
  const base = memory.pipeline.bind(memory);
  memory.pipeline = async commands => commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === counter ? reply as unknown as unknown[] : base(commands);
  try {
    let result: unknown;
    try { result = await nudgesThisMonth(store, now); } catch { result = "unknown"; }
    assert.notEqual(typeof result, "number", "an unread or malformed monthly count must remain unknown, not a published count");
  } finally { memory.pipeline = base; }
});
for (const [reply, expected] of [[[null], 0], [["0"], 0], [["12"], 12]] as const) test("confirmed monthly notice count retains meaning: " + expected, async () => {
  reset();
  const base = memory.pipeline.bind(memory);
  memory.pipeline = async commands => commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === counter ? [...reply] : base(commands);
  try { assert.equal(await nudgesThisMonth(store, now), expected); }
  finally { memory.pipeline = base; }
});
