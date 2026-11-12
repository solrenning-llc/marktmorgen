/**
 * Claude 3 (cloud A), CX-123 rule 24 (lib/move-repair.ts): logging out the
 * address a broken move left behind is part of repairing or clearing it, and
 * endAllSessions answers null when it cannot confirm that. Before, both
 * repairMove and clearBrokenMoveByHand went on regardless: the record was
 * cleared and the support script (scripts/move-repair.mjs) printed
 * "Repaired" / "Cleared, and both addresses logged out" while sessions of the
 * other address may still be open. Now an unconfirmed log-out keeps the
 * record, so the next login or the script tries again, and says so.
 *
 * Nothing real: the Redis stub and synthetic addresses.
 */
import { createHash } from "node:crypto";
import { markBrokenMove, openSession, readBrokenMove } from "@/lib/auth";
import { clearBrokenMoveByHand, repairMove } from "@/lib/move-repair";
import { claimHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const hex = (v: string) => createHash("sha256").update(v).digest("hex");
const sessionsKey = (email: string) => `nl:auth:sessions:${hex(`nimbus-auth-sessions:${email}`).slice(0, 40)}`;

const real = redis.pipeline.bind(redis);
let crooked = "";
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return crooked ? values.map((v, i) => (batch[i][0] === "SMEMBERS" && batch[i][1] === crooked ? "not a set" : v)) : values;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();

  part("Repairing: an unconfirmed log-out of the address left behind is not a repair");
  const HOME = "home-a@example.com";
  const AWAY = "away-a@example.com";
  await claimHandle(HOME, "home-a", "Home", "");
  await markBrokenMove(HOME, AWAY);
  await openSession(AWAY);
  crooked = sessionsKey(AWAY);
  const repaired = await repairMove(HOME).catch(() => "threw");
  crooked = "";
  is("not said as repaired", repaired === true, false);
  is("the record is kept, for the next login or the support script", Boolean(await readBrokenMove(HOME)), true);
  is("control: with the log-out confirmed, it is repaired", await repairMove(HOME), true);
  is("and the record is gone", await readBrokenMove(HOME), null);

  part("Clearing by hand: never 'cleared, and both addresses logged out' on an unconfirmed log-out");
  const A = "clear-a@example.com";
  const B = "clear-b@example.com";
  await markBrokenMove(A, B);
  await openSession(B);
  crooked = sessionsKey(B);
  const cleared = await clearBrokenMoveByHand(A, A).catch(() => "threw");
  crooked = "";
  is("not said as cleared", cleared === "cleared", false);
  is("the record is kept", Boolean(await readBrokenMove(A)), true);
  is("control: with the log-out confirmed, it is cleared", await clearBrokenMoveByHand(A, A), "cleared");
  is("and the record is gone", await readBrokenMove(A), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
