/**
 * Node 24 can deadlock inside process.exit(): the main thread waits for the V8 worker threads to stop while one
 * of them waits for a garbage collection only the main thread can run (CI verify hung for 48 min right after
 * "96 checks, all passing." in 9 jobs on 6 November; gdb: MainThread in NodePlatform::Shutdown/uv_thread_join,
 * V8Worker in CollectionBarrier::AwaitCollectionBackground; nodejs/node#64560). A test file must end by its exit
 * code, so the heap is torn down before the platform is.
 *
 * The proof runs children that allocate hard and then call done(), with V8's --stress-concurrent-allocation,
 * which makes that race frequent; with process.exit() about a third of them never end. Each child gets 15 s.
 *
 * Run it by hand on the CI's Node (24.x): node tests/run-one is not needed — bundle it like any test and run it.
 * It is a .proof.ts, not a .test.ts, so the suite does not run 16 stressed children on every verify, and on
 * Node 22 the stress flag hangs children even on a normal exit, so the proof is meaningful only on Node 24.
 */
import { spawn } from "node:child_process";
import { done, is, part } from "./check";

const CHILDREN = 16;
const AT_ONCE = 8;
const LIMIT_MS = 15_000;

function allocateThenDone(): void {
  const keep: unknown[] = [];
  const until = Date.now() + 300;
  while (Date.now() < until) {
    keep.push(new Array(2_000).fill(Math.random()));
    if (keep.length > 400) keep.splice(0, 200);
  }
  is("the child counted its one check", keep.length > 0, true);
  done();
}

function runChild(): Promise<"ended" | "hung"> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--stress-concurrent-allocation", process.argv[1]], { env: { ...process.env, CHECK_EXIT_CHILD: "1" }, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("hung");
    }, LIMIT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve("ended");
    });
  });
}

async function main(): Promise<void> {
  part("A test file that has printed its result also ends (no deadlock inside process.exit)");
  const results: ("ended" | "hung")[] = [];
  for (let i = 0; i < CHILDREN; i += AT_ONCE) results.push(...(await Promise.all(Array.from({ length: Math.min(AT_ONCE, CHILDREN - i) }, runChild))));
  is(`all ${CHILDREN} children that allocate hard and call done() end within ${LIMIT_MS / 1000} s`, results.filter((r) => r === "hung").length, 0);
  done();
}

if (process.env.CHECK_EXIT_CHILD === "1") allocateThenDone();
else main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
