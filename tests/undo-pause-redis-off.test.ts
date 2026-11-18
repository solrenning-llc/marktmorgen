/**
 * Without Redis, taking a break back is unknown, never "no break" (Codex X6's LOW on #3752). undoPause runs under the
 * store's lock (withStoreLock, lib/store.ts), whose "moved" also stands for a deployment with no Redis; mapped to
 * "none", the page would tell a creator with a break set that there was none. Real code; the Redis stub switched off.
 */
import { undoPause } from "@/lib/plan-pause";
import { claimHandle, storeForEmail } from "@/lib/store";
import { setRedisConfigured } from "./redis-off-world";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const OWNER = "owner@undopauseoff.example";
  await claimHandle(OWNER, "undopauseoff", "Undo Pause Off", "");
  const store = (await storeForEmail(OWNER))!;

  part("Taking a break back while Redis is not set up");
  setRedisConfigured(false);
  const answer = await undoPause(store).then((kind) => `answered ${kind}`, (error: Error) => `threw ${error.message}`);
  setRedisConfigured(true);
  is("it is not answered as no break", answer === "answered none", false);
  is("it says the break could not be confirmed", answer, "threw the break could not be confirmed");
  done();
}
void main();
