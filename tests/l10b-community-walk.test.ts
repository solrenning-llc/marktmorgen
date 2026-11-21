/**
 * CX-123 rule 24, lot L10b: the one walk of a community's archive into its search index (lib/community-walk.ts) runs
 * under a two-minute lock taken with SET NX, so two people searching at once do not both walk and both pay. A reply to
 * it in any shape but "OK" or nil is read back: our own value is ours and the walk runs; another value is another walk
 * running now, and this one does not; nothing readable does not walk now (the next search does). The lock is let go
 * only while it holds our own value: a walk that outlasted its lock never deletes the lock of the walk that took it.
 */
import { claimHandle, ensureStatsId, setCommunity, setSubscription } from "@/lib/store";
import { needsWalk, walkCommunity } from "@/lib/community-walk";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ODD, THROWS, UNREADABLE, answer, clearAnswers, getOf, setNx } from "./l10b-replies";

async function main(): Promise<void> {
  redis.clear();
  const C = "l10b-club@example.com";
  await claimHandle(C, "lclub", "Club", "");
  await ensureStatsId(C);
  await setSubscription(C, { customerId: "cus_lclub", subscriptionId: "sub_lclub", active: true, tier: "pro", period: paidPeriod() });
  const club = (await setCommunity(C, true))!;
  const id = club.community!.id;
  const lock = `nl:cm:${id}:swalk`;
  const unmark = () => redis.run(["DEL", `nl:cm:${id}:sv`]);
  let paid = 0;
  const pay = async () => {
    paid += 1;
    return true;
  };

  part("The plain case: walked once and marked");
  unmark();
  paid = 0;
  is("walked, paid as it went, marked, its lock let go", [await walkCommunity(club, pay), paid > 0, await needsWalk(id), redis.run(["EXISTS", lock])], [true, true, false, 0]);

  part("A walk already running is never taken for ours");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    unmark();
    paid = 0;
    redis.run(["SET", lock, "another-walk", "EX", 120]);
    answer(setNx(lock), reply);
    const walked = await walkCommunity(club, pay);
    is(`the lock answered with ${shape} while another walk holds it: not walked, nothing paid, its lock kept`, [walked, paid, redis.run(["GET", lock])], [false, 0, "another-walk"]);
    redis.run(["DEL", lock]);
  }

  part("The lock written and its answer lost: our own value read back, walked once");
  for (const [shape, reply] of ODD) {
    clearAnswers();
    unmark();
    paid = 0;
    answer(setNx(lock), reply);
    is(`answered with ${shape}, the write landed: walked and its lock let go`, [await walkCommunity(club, pay), paid > 0, redis.run(["EXISTS", lock])], [true, true, 0]);
  }

  part("Nothing readable: not walked now, still to be done");
  for (const [shape, reply] of [...UNREADABLE, ["the write failing too", THROWS] as const]) {
    clearAnswers();
    unmark();
    paid = 0;
    answer(setNx(lock), shape === "the write failing too" ? THROWS : () => ["QUEUED"], { run: false });
    answer(getOf(lock), reply);
    const walked = await walkCommunity(club, pay).catch(() => "threw");
    is(`the lock unknown and its read-back ${shape}: not walked, nothing paid`, [walked, paid, await needsWalk(id)], [false, 0, true]);
  }

  part("A walk that outlasted its lock leaves the next walk's lock alone");
  clearAnswers();
  unmark();
  const outlasted = await walkCommunity(club, async () => {
    redis.run(["SET", lock, "the-next-walk", "EX", 120]);
    return true;
  });
  is("walked, and the next walk's lock is still there", [outlasted, redis.run(["GET", lock])], [true, "the-next-walk"]);
  redis.run(["DEL", lock]);
  clearAnswers();
  done();
}

void main();
