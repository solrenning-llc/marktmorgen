/** Independent observational control: synthetic first SSCAN held beyond the 60s lease; no latency claim. */
import { readDirectory } from "@/lib/affiliate-directory";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
async function scenario(ms: number): Promise<void> {
  redis.clear();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const held = new Promise<void>((r) => { release = r; });
  let scans = 0, firstFinished = false;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") {
      scans += 1;
      if (scans === 1) { entered(); await held; }
      return [["0", []]];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const first = readDirectory().then(() => { firstFinished = true; }, () => { firstFinished = true; });
  await started;
  advance(ms);
  const second = await readDirectory().then(() => "answered", (e: Error) => e.name);
  const snapshot = { scans, firstFinished, second };
  release();
  await first;
  redis.pipeline = original;
  console.log("  schedule " + JSON.stringify({ms, ...snapshot}));
  is("first build is still unfinished when the second returns", snapshot.firstFinished, false);
  is("an unfinished first build admits no second scan", snapshot.scans, 1);
  is("second call is unavailable while first build is unfinished", snapshot.second, "UnknownReplyError");
}
async function main(): Promise<void> {
  part("Control: held scan, only 59 synthetic Redis seconds");
  await scenario(59_000);
  part("Conditional: same held scan, 61 synthetic Redis seconds");
  await scenario(61_000);
  done();
}
void main();
