/**
 * Two sends of one store at the same moment (a campaign and a sequence, or an
 * import's welcome emails) never take the same open portion twice: what they
 * are given together never passes what the portion had left.
 */
import { RAMP_FIRST, RAMP_TRIGGER } from "@/lib/mail-health-rules";
import { rampRoom, startRamp } from "@/lib/mail-health";
import "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  part("A portion is taken once");
  const id = "ramp-race-store";
  await startRamp(id, RAMP_TRIGGER);
  const given = await Promise.all([rampRoom(id, RAMP_FIRST), rampRoom(id, RAMP_FIRST), rampRoom(id, RAMP_FIRST)]);
  const total = given.reduce((sum, n) => sum + n, 0);
  is("together they are given no more than the first portion", total <= RAMP_FIRST, true);
  is("and the portion is not lost: one of them got it", total > 0, true);
  done();
}
void main();
