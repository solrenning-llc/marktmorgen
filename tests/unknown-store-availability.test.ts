/**
 * The ceiling on store addresses that lead nowhere must never take a real store off the air (coordinator's review of
 * claude5/unknown-store-ceiling, 9 November 2026). Whether an address has a store is decided by the small index read
 * storeForHandle already makes (nl:store:handle:<handle>), never by the company's ceiling: past the day's ceiling, or
 * with a count that cannot be read, a real store this server has not seen still opens, and a made-up address costs
 * only that small read, never the store's record. The lookup is counted before the read, in the same round trip.
 */
import { claimHandle, storeForVisitor } from "@/lib/store";
import { STORE_MISSES_PER_DAY, forgetStoreLookups } from "@/lib/store-lookup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const isCount = (c: Command) => /^(INCR|INCRBY|HINCRBY)$/.test(String(c[0])) && String(c[1]).startsWith("nl:store-lookup:");

/** Runs `run` with every count of the lookup answered `answer`, the rest as Redis answers it; returns what was sent. */
async function counted(answer: unknown, run: () => Promise<unknown>): Promise<Command[][]> {
  const original = redis.pipeline.bind(redis);
  const sent: Command[][] = [];
  redis.pipeline = async (cmds) => {
    sent.push(cmds);
    const out = await original(cmds);
    return answer === undefined ? out : out.map((value, i) => (isCount(cmds[i]!) ? answer : value));
  };
  try { await run(); } finally { redis.pipeline = original; }
  return sent;
}

async function main(): Promise<void> {
  redis.clear();
  for (const handle of ["realopen", "realopen2", "realopen3"]) await claimHandle(`${handle}@example.com`, handle, handle, "");

  part("Past the company's day, a real store this server has not seen still opens");
  forgetStoreLookups();
  await counted(STORE_MISSES_PER_DAY + 5, () => storeForVisitor("madeupone"));
  is("a real store opens past the ceiling", (await storeForVisitor("realopen"))?.handle, "realopen");
  const past = await counted(STORE_MISSES_PER_DAY + 6, () => storeForVisitor("madeuptwo"));
  const pastCommands = past.flat();
  is("a made-up address past it costs at most the small index read", pastCommands.filter((c) => !isCount(c)).length <= 1, true);
  is("and never the store's record", pastCommands.some((c) => String(c[1]).startsWith("nl:store:owner:")), false);

  part("A count that cannot be read never hides a real store");
  forgetStoreLookups();
  await counted("garbled", () => storeForVisitor("madeupthree"));
  is("a real store opens after an unreadable count", (await storeForVisitor("realopen2"))?.handle, "realopen2");

  part("The lookup is counted before the read, in the same round trip");
  forgetStoreLookups();
  const sent = await counted(undefined, () => storeForVisitor("madeupfour"));
  const read = sent.findIndex((cmds) => cmds.some((c) => c[0] === "GET" && c[1] === "nl:store:handle:madeupfour"));
  const count = sent.findIndex((cmds) => cmds.some(isCount));
  is("the count and the index read go together", [count, read], [0, 0]);
  is("a real store found this way is the store", (await storeForVisitor("realopen3"))?.handle, "realopen3");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
