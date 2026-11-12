/**
 * lib/claim-mark.ts: a claim is ours only on OK or on our own value read back (Claude 4 on #2714), and it is let go
 * only while it still holds our own value (Revisor 1 on #2719): a run whose mark ran out and was taken by another
 * run never deletes the other run's mark when it fails.
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  part("Taken and let go by the same run");
  const mine = claimValue();
  is("taken", await claimMark("nl:test:claim:a", 60, mine), "ours");
  is("taken again by another: not ours", await claimMark("nl:test:claim:a", 60), "taken");
  await releaseMark("nl:test:claim:a", mine);
  is("let go by its own run", redis.run(["EXISTS", "nl:test:claim:a"]), 0);

  part("A mark that ran out and was taken by another run is not ours to let go");
  const first = claimValue();
  await claimMark("nl:test:claim:b", 60, first);
  redis.run(["DEL", "nl:test:claim:b"]);
  const second = claimValue();
  is("the second run takes it", await claimMark("nl:test:claim:b", 60, second), "ours");
  await releaseMark("nl:test:claim:b", first);
  is("the first run failing later leaves the second run's mark alone", redis.run(["GET", "nl:test:claim:b"]), second);
  done();
}

void main();
