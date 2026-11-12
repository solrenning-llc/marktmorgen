/**
 * What a creator spent on ads is the typed lines and, while the store is
 * connected to Meta, the lines read from its ad account (lib/ad-spend.ts,
 * readSpends). Every figure that uses spend uses both: the studio's "after
 * ads", the weekly email and the numbers the AI answers from. Before, a read
 * of the Meta lines that failed, or that Redis answered in another shape,
 * was swallowed: readSpends handed back the typed lines alone, as if they
 * were all the spend, and every return on ads read higher than it was. Now
 * such a read throws, so each caller shows the spend as not read (the AI is
 * told it is missing, never zero). Synthetic data only.
 */
import { readSpends } from "@/lib/ad-spend";
import { linesKey } from "@/lib/meta-ads";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;
const statsId = "adspendmetaunknown000000000001";
const typed = { channel: "google", campaign: "", cents: 1_000, from: "2026-11-01", to: "2026-11-07" };
const meta = [{ id: "meta-0123456789ab", channel: "meta", campaign: "Fall", cents: 50_000, from: "2026-11-01", to: "2026-11-07" }];

async function run(swap?: (real: unknown[]) => unknown): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    if (swap && commands.some(([name]) => name === "EXISTS")) {
      const real = await original(commands);
      return swap(real) as unknown[];
    }
    return original(commands);
  };
  try {
    return (await readSpends(statsId)).map((s) => s.cents);
  } catch {
    return "unknown";
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  redis.run(["HSET", `nl:stats:${statsId}:spend`, "0a0b0c0d", JSON.stringify(typed)]);
  redis.run(["SET", `nl:metaads:conn:${statsId}`, "{}"]);
  redis.run(["SET", linesKey(statsId), JSON.stringify(meta)]);

  part("Both kinds of line, read as they always were");
  is("the typed line and the Meta line", await run(), [1_000, 50_000]);

  part("A Meta read that fails is unknown, never the typed lines alone");
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["a read that fails", () => { throw new Error("Redis request timed out (test)"); }],
    ["an empty envelope", () => []],
    ["a connection count that is text", (real) => ["1", real[1]]],
    ["a connection count that is missing", (real) => [undefined, real[1]]],
    ["kept lines that are a number", (real) => [real[0], 7]],
    ["kept lines that do not read", (real) => [real[0], "{not json"]],
  ];
  for (const [what, swap] of shapes) is(`${what}: unknown`, await run(swap), "unknown");

  part("A store not connected has no Meta lines");
  redis.run(["DEL", `nl:metaads:conn:${statsId}`]);
  is("the typed line only", await run(), [1_000]);
  done();
}

void main();
