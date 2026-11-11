/**
 * The DNS race in lib/domain-proof.ts (txtRecords) gives up after 4 s. When the DNS answers first, its timer must be
 * cleared: a timer left alive keeps the process (and the test run) waiting 4 s after every check (C4-3000, on #2859).
 * The DNS is played by a stand-in that answers at once.
 */
import dns from "node:dns/promises";
import { proofRecord } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const store = { sid: "timerdomainstore0000000000000001", handle: "tmine", previousHandles: [] as string[] };
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async (host: string) => {
  const name = host.replace(/^_marktmorgen\./, "");
  return [[proofRecord(store, name).value]];
};

/** The stand-in runs no Lua: lib/domain-proof.ts's swap, played here as in tests/l10b-domain-proof.test.ts. */
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('if redis.call("GET", KEYS[1]) ~= ARGV[1]')) {
    const [, script, , key, expected, next] = commands[0].map(String);
    if (redis.run(["GET", key]) !== expected) return [0];
    redis.run(script.includes("KEEPTTL") ? ["SET", key, next, "KEEPTTL"] : ["SET", key, next]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

async function main(): Promise<void> {
  redis.clear();
  part("The DNS answers at once: no timer is left running");
  const before = timers();
  const result = await proveDomain(store, "shop1.timer.invalid");
  is("proved, and no timer outlives the check", [result, timers() - before], ["proved", 0]);
  done();
}

void main();
