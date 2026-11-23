/**
 * tests/skip-waits.ts skips only the named functions' own sleep, never a timer set deeper inside them.
 *
 * Claude 2's LEVE on #4523 @73ae8837d1 (6877011736): the stack test matched any timer whose stack held
 * `at async takeLock`, so a timer set by something takeLock awaits (timed()'s request cutoff in lib/fetch-timeout.ts,
 * under the real lib/redis.ts) would have fired at once and moved the clock. Now only a timer whose first named frame
 * below setTimeout is takeLock or paced itself is skipped.
 *
 * Local functions named like the library's stand in for them: the stack test reads names only.
 */
import { ownWait, skipWaits } from "./skip-waits";
import { done, is, part } from "./check";

const waits = skipWaits(["takeLock"]);

/** A request with its own cutoff, as lib/fetch-timeout.ts timed() sets one: the timer is set here, not in takeLock. */
async function timed(ms: number): Promise<number> {
  const timer = setTimeout(() => undefined, ms);
  clearTimeout(timer);
  return waits.skipped();
}

/** Sleeps between tries as lib/redis-lock.ts does, after awaiting a request with its own cutoff. */
async function takeLock(sleep: number, cutoff: number): Promise<{ afterCutoff: number; afterSleep: number }> {
  await Promise.resolve();
  const afterCutoff = await timed(cutoff);
  await new Promise((resolve) => setTimeout(resolve, sleep));
  return { afterCutoff, afterSleep: waits.skipped() };
}

async function main(): Promise<void> {
  part("Inside takeLock, its own sleep is skipped and a request's cutoff is not");
  const started = Date.now();
  const seen = await takeLock(4_000, 9_000);
  is("the cutoff set by the request takeLock awaits keeps its real time: the clock did not move", seen.afterCutoff, 0);
  is("takeLock's own sleep is skipped: the clock moved by it", seen.afterSleep, 4_000);
  is("and it did not sit for it", Date.now() - started - seen.afterSleep < 2_000, true);

  part("ownWait reads the first named frame below setTimeout");
  const own = ["Error", "    at globalThis.setTimeout (/repo/tests/skip-waits.ts:40:21)", "    at /repo/lib/redis-lock.ts:81:28", "    at new Promise (<anonymous>)", "    at takeLock (/repo/lib/redis-lock.ts:81:11)"].join("\n");
  const deeper = ["Error", "    at globalThis.setTimeout (/repo/tests/skip-waits.ts:40:21)", "    at timed (/repo/lib/fetch-timeout.ts:12:17)", "    at redisPipeline (/repo/lib/redis.ts:90:10)", "    at async takeLock (/repo/lib/redis-lock.ts:70:5)"].join("\n");
  is("takeLock's own sleep", ownWait(own, ["takeLock"]), true);
  is("a cutoff set by timed() under takeLock", ownWait(deeper, ["takeLock"]), false);
  is("a name that was not asked for", ownWait(own, ["paced"]), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
