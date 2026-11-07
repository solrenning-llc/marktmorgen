import assert from "node:assert/strict";
import { readDirectory, DirectoryBusyError } from "@/lib/affiliate-directory";
import { store as redis, advance } from "./redis-stub";

async function scenario(elapsed: number) {
  redis.clear();
  const original = redis.pipeline.bind(redis);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const held = new Promise<void>(r => { release = r; });
  let scans = 0;
  redis.pipeline = (async commands => {
    if (commands[0]?.[0] === "SSCAN" && ++scans === 1) { enter(); await held; }
    return original(commands);
  }) as typeof redis.pipeline;
  const first = readDirectory();
  await entered;
  advance(elapsed);
  let busy = false;
  try { await readDirectory(); } catch (e) { if (!(e instanceof DirectoryBusyError)) throw e; busy = true; }
  release();
  await first;
  redis.pipeline = original;
  return { scans, busy };
}
async function main() {
  const control = await scenario(0);
  assert.deepEqual(control, { scans: 1, busy: true });
  const expired = await scenario(61_000);
  console.log(JSON.stringify({control, expired, syntheticElapsedMs:61_000}));
  assert.equal(expired.scans, 1, "an unfinished build must exclude a second assembly if the single-flight guarantee holds");
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
