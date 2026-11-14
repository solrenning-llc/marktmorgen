/**
 * The studio's count of the Store assistant's month (lib/store-assistant.ts, assistantLeft) reads the pool exactly
 * (rule MR, rule 24): a field of the pool that does not read as the pool's own script writes it (digits only, no
 * leading zero, a safe integer), or a reply that is not a list, is unknown, and the count says nothing (null, which
 * the studio shows as not read), never "the whole month left". The pool's own script (ASSISTANT_POOL) already
 * refuses such a pool, so no reply is spent; this keeps the studio from saying otherwise.
 */
import { assistantLeft } from "@/lib/store-assistant";
import { assistantPoolMicroUsd } from "@/lib/store-assistant-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();
const now = Date.now();
const start = Math.floor(now / 1000) - 86_400;
const period = { start, end: start + 31 * 86_400, renews: true };
const plan = { subscriptionId: "sub_Assist00001", active: true, period, cancelsAtEnd: false, disputedAt: "" };
const store = { statsId: "s1", assistantPlan: plan } as unknown as Store;
const pool = `nl:assist:pool:s1:${new Date(start * 1000).toISOString().slice(0, 10)}`;
const cap = String(assistantPoolMicroUsd());

async function main() {
  part("A pool in its own shape is counted");
  redis.run(["HSET", pool, "cap", cap, "held", "0", "spent", "0", "n", "0"]);
  const whole = await assistantLeft(store, now);
  is("an empty month: replies left, none answered", [whole !== null && whole.left > 0, whole?.answered], [true, 0]);

  part("A field that does not read is unknown, never zero");
  for (const [field, value] of [["held", "abc"], ["spent", "-5"], ["spent", "1.5"], ["held", "007"], ["n", "x"], ["cap", ""]] as const) {
    redis.run(["DEL", pool]);
    redis.run(["HSET", pool, "cap", cap, "held", "0", "spent", "0", "n", "0"]);
    redis.run(["HSET", pool, field, value]);
    is(`${field} = ${JSON.stringify(value)}: not read, so no count`, await assistantLeft(store, now), null);
  }

  part("A reply that is not a list is unknown");
  const original = redis.pipeline.bind(redis);
  for (const reply of [null, "OK", 7]) {
    redis.pipeline = (async () => [reply]) as typeof redis.pipeline;
    is(`HGETALL answered ${JSON.stringify(reply)}: no count`, await assistantLeft(store, now), null);
  }
  redis.pipeline = original;

  part("No pool yet is a whole month, as before");
  redis.run(["DEL", pool]);
  const fresh = await assistantLeft(store, now);
  is("nothing written this month: every reply left", fresh !== null && fresh.left > 0 && fresh.answered === 0, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
