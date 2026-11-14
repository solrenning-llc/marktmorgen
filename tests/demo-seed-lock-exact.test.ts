/**
 * The demo store's build lock is taken exactly (lib/demo-seed.ts, ensureDemoStore; CX-123 rule 24, lib/claim-mark.ts).
 * Found by Claude 3 (cloud D)'s audit of main (11 November 2026): the lock was SET NX read loosely, so an answer lost
 * on the way back while another run held the lock built the demo store a second time beside it (its photos fetched
 * and stored again), and the plain DEL in `finally` deleted the other run's lock. Now the lock is a claimMark: an
 * answer that proves nothing is read back; another run's lock is "busy" and left as it is; this run lets go only of
 * its own. Synthetic only: the file store and the photo host are stand-ins, and nothing else answers.
 */
import { type SeedDeps, ensureDemoStore } from "@/lib/demo-seed";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const LOCK = "nl:house:seed:lock";
let calls = 0;
const deps: SeedDeps = {
  putFile: async () => { calls += 1; },
  removeFile: async () => { calls += 1; },
  fetchBytes: async () => { calls += 1; throw new Error("fetch_502"); },
};
let outside = 0;
globalThis.fetch = (async () => {
  outside += 1;
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

// Another run holds the lock; this run's SET NX lands nowhere and its answer is lost.
let lost = false;
const run = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  if (lost && commands.some((c) => c[0] === "SET" && c[1] === LOCK && c.includes("NX"))) {
    await run(commands);
    return [];
  }
  return run(commands);
};

async function main() {
  redis.clear();
  await run([["SET", LOCK, "another-run", "EX", 120]]);
  lost = true;
  const result = await ensureDemoStore(deps);
  lost = false;
  is("another run holds the lock and this run's answer was lost: nothing is built", [result.ran, calls + outside], [false, 0]);
  is("and the other run's lock is left as it was", (await run([["GET", LOCK]]))[0], "another-run");
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
