/**
 * CX-123 rule 24 on the shared numbers link (/numbers/<id>,
 * app/numbers/[id]/page.tsx, lib/numbers-links.ts): the link's index read in
 * an unknown shape is unknown, never "This link has ended"; the day's count
 * of openings in an unknown shape is unknown, never zero (which let one more
 * opening past OPENS_PER_DAY) and never "Opened too many times today". Each
 * throws UnknownReplyError, and the page says it did not load (app/error.tsx).
 */
import { countOpen, linkStore } from "@/lib/numbers-links";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const ID = "a1".repeat(10);
const NOW = Date.UTC(2026, 10, 6, 12);
function answer(match: (batch: Command[]) => boolean, reply: unknown): void {
  redis.pipeline = (async (batch: Command[]) => (match(batch) ? reply : real(batch))) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real as typeof redis.pipeline;
};
async function outcome(read: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await read());
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}
const isIndexRead = (batch: Command[]) => batch.length === 1 && batch[0][0] === "GET";
const isOpenCount = (batch: Command[]) => batch[0]?.[0] === "INCR";

async function main(): Promise<void> {
  redis.clear();
  is("a link nobody has finds nothing", await linkStore(ID), null);
  await real([["SET", `nl:nlink:${ID}`, "f".repeat(32)]]);
  is("a link as kept finds its store", await linkStore(ID), "f".repeat(32));
  is("an opening as kept is counted", await countOpen(ID, NOW), true);

  part("The link's index in an unknown shape is unknown, never 'This link has ended'");
  for (const [name, reply] of [["a cut-short pipeline", []], ["a number", [7]], ["an object", [{ sid: "x" }]], ["a list", [["x"]]], ["not a list", { 0: "x" }]] as [string, unknown][]) {
    answer(isIndexRead, reply);
    is(`${name}: unknown`, await outcome(() => linkStore(ID)), "unknown");
    restore();
  }

  part("The day's openings in an unknown shape are unknown, never zero nor 'too many'");
  for (const [name, reply] of [["a cut-short pipeline", []], ["null for the count", [null, 1]], ["a string for the count", ["3", 1]], ["a negative count", [-1, 1]], ["a fraction", [1.5, 1]], ["not a list", { 0: 1, 1: 1 }]] as [string, unknown][]) {
    answer(isOpenCount, reply);
    is(`${name}: unknown`, await outcome(() => countOpen(ID, NOW)), "unknown");
    restore();
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
