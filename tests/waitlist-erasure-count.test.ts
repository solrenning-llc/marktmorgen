/**
 * Deleting a person takes them off every waitlist of the store
 * (forgetWaitlistPerson, lib/person-erasure.ts). Each HDEL's answer was read
 * with `Number(n) || 0`, so a reply in another shape (no reply, a word, a
 * list, a fraction) was counted as "nothing there to delete" and the erasure
 * was said as finished while the place may still be kept (rule 24). Now an
 * unknown deletion answer throws, so the erasure is reported as not done and
 * tried again. Control: exact answers still delete the place and count it.
 * Synthetic data; no provider is called.
 */
import { forgetWaitlistPerson } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "stats_harbor";
const PRODUCTS = ["prod_a", "prod_b"];
const place = JSON.stringify({ at: 1, ok: 1, c: false, t: "a".repeat(48) });

async function main(): Promise<void> {
  redis.clear();
  const real = redis.pipeline.bind(redis);
  const seed = () => {
    for (const p of PRODUCTS) redis.run(["HSET", `nl:wl:${SID}:${p}`, "dana@example.com", place]);
  };

  part("An unknown deletion answer is never read as \"nothing to delete\"");
  for (const [label, shape] of [
    ["no reply", () => undefined],
    ["a word", () => "OK"],
    ["a list", () => [1]],
    ["a fraction", () => 0.5],
    ["a negative number", () => -1],
    ["one reply short", null],
  ] as [string, (() => unknown) | null][]) {
    redis.clear();
    seed();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      if (commands[0]?.[0] !== "HDEL") return replies;
      return shape ? [shape(), ...replies.slice(1)] : replies.slice(0, -1);
    }) as typeof redis.pipeline;
    const outcome = await forgetWaitlistPerson(SID, PRODUCTS, "dana@example.com").then(
      (n) => `finished (${n})`,
      () => "not finished",
    );
    redis.pipeline = real;
    is(`(${label}) the erasure is not said as finished`, outcome, "not finished");
  }

  part("Control: exact answers delete and count every place");
  redis.clear();
  seed();
  is("two places deleted", await forgetWaitlistPerson(SID, PRODUCTS, "Dana@Example.com"), 2);
  is("none kept", PRODUCTS.map((p) => redis.run(["HGET", `nl:wl:${SID}:${p}`, "dana@example.com"])), [null, null]);
  is("a second run finds nothing", await forgetWaitlistPerson(SID, PRODUCTS, "dana@example.com"), 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
