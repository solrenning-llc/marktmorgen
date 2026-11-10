/**
 * 750 [CD1] unit 5: what a buyer's list of their own files for review costs
 * (lib/submission-store.ts, buyerSubmissionsFor; the route's "mine"), held
 * below what it pays. The request takes one of the store's public requests
 * before anything is read, as every step of the door does (unit 2): that one
 * covers the route's own reads before the list and the buyer's index (one
 * command), as it covers them for signing or giving an upload up. Then, once
 * the list knows how many records it will read, it takes mineUnits(n) more,
 * before reading them. At every count from one to MAX_SUBMISSIONS_PER_PERSON,
 * those, each priced as a later page (tests/traffic-cost.ts), cost more than
 * the list's own work at its heaviest: two reads a record, every record and
 * door at its largest through the database, every record sent on, and the
 * longer wait and work of a heavy request over a light one.
 */
import { MAX_SUBMISSIONS_PER_PERSON, MAX_SUBMISSION_RECORD_BYTES } from "@/lib/submission-rules";
import { SUBMISSION_STEP_COMMANDS, mineUnits } from "@/lib/submission-store";
import { ORIGIN_PER_BYTE, request } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { done, is, part } from "./check";

/** A door at its largest (lib/submission-store.ts MAX_DOOR_BYTES) and an index entry, with a path at its longest. */
const DOOR_BYTES = 4_096;
const ENTRY_BYTES = 400;

part("A buyer's list of their files, paid before it is read");
const short: string[] = [];
for (let n = 1; n <= MAX_SUBMISSIONS_PER_PERSON; n += 1) {
  const paid = mineUnits(n) * laterPageCost();
  // A heavy request's own price less a light one's: its longer wait and work, with the list's commands and bytes.
  const costs =
    request("heavy", 2 * n, n * (MAX_SUBMISSION_RECORD_BYTES + DOOR_BYTES + ENTRY_BYTES)) - request("light", 0) + n * MAX_SUBMISSION_RECORD_BYTES * ORIGIN_PER_BYTE;
  if (paid < costs) short.push(`${n}: ${paid} < ${costs}`);
}
is("at every count, what it pays covers what it costs", short, []);
is("its commands beyond the route's are the index and two a record", SUBMISSION_STEP_COMMANDS.mine, 1 + 2 * MAX_SUBMISSIONS_PER_PERSON);
is("a list of none pays nothing beyond its first request", mineUnits(0), 0);
is("more records never pay less", Array.from({ length: MAX_SUBMISSIONS_PER_PERSON }, (_, i) => mineUnits(i + 1) >= mineUnits(i)).every(Boolean), true);
console.log(`  a list of ${MAX_SUBMISSIONS_PER_PERSON}: ${1 + mineUnits(MAX_SUBMISSIONS_PER_PERSON)} public requests at $${laterPageCost().toFixed(6)}`);

done();
