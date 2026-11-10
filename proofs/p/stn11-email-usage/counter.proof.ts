import assert from "node:assert/strict";
import { usedThisMonthExact } from "@/lib/mail";
import { confirmedEmailUsage } from "@/lib/email-usage-summary";
import { store } from "../../../tests/redis-stub";

const original = store.pipeline.bind(store);
let reply: unknown[] = [null];
let calls = 0;
store.pipeline = async (commands) => {
  calls++;
  assert.deepEqual(commands, [["GET", "nl:mail:used:synthetic-list:synthetic-period"]]);
  return reply;
};
let assertions = 0;
try {
  for (const [raw, expected] of [[null, 0], ["0", 0], ["2345", 2345], ["-1", -1]] as const) {
    reply = [raw];
    const count = await usedThisMonthExact("synthetic-list", "synthetic-period");
    assert.equal(count, expected); assertions++;
    assert.equal(confirmedEmailUsage(count), expected >= 0 ? expected : null); assertions++;
  }
  for (const raw of [[], [undefined], [0], [""], ["1.5"], ["wat"], ["Infinity"], [{ error: "synthetic" }], [null, "extra"]]) {
    reply = raw;
    await assert.rejects(() => usedThisMonthExact("synthetic-list", "synthetic-period")); assertions++;
  }
  assert.equal(calls, 13); assertions++;
  console.log(JSON.stringify({ assertions, calls, realNetwork: 0, boundary: "actual mail reader; synthetic pipeline replies" }));
} finally {
  store.pipeline = original;
}
