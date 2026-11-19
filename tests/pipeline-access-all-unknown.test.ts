/**
 * Every teammate's pipeline restrictions are read exactly (Claude 5's LOW on #2036): an answer that is not the one
 * HGETALL's list or object is unknown, never "nobody is restricted", so the Team page says it could not read them
 * instead of showing everyone as "Can change". Synthetic records (MemoryRedis); no outside request.
 */
import { readAllPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "access-all-owner@example.test";
  await claimHandle(owner, "accessall", "Access All", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!;
  await writePipelineAccess(store.statsId!, "sam@example.test", { sales0: "none" }, store);

  part("Control");
  is("a healthy read names Sam's restriction", await readAllPipelineAccess(store.statsId), { "sam@example.test": { sales0: "none" } });

  const pipe = redis.pipeline.bind(redis);
  for (const [label, shape] of [
    ["no reply at all", []],
    ["a number", [7]],
    ["nothing in the reply", [undefined]],
    ["a list cut to an odd length", [["sam@example.test"]]],
    ["a list with a number in it", [["sam@example.test", 3]]],
    ["two replies for one command", [[], []]],
  ] as [string, unknown[]][]) {
    part(label);
    redis.pipeline = (async (cs: (string | number)[][]) => (cs.length === 1 && cs[0][0] === "HGETALL" ? shape : pipe(cs))) as typeof redis.pipeline;
    const answer = await readAllPipelineAccess(store.statsId).then((v) => JSON.stringify(v), () => "unknown");
    redis.pipeline = pipe;
    is(`${label}: unknown, never "nobody is restricted"`, answer, "unknown");
  }
  part("A confirmed empty record");
  await writePipelineAccess(store.statsId!, "sam@example.test", {}, store);
  is("nobody restricted, for certain", await readAllPipelineAccess(store.statsId), {});
  is("no outside request", outside, 0);
  done();
}
void main();
