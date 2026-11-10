/**
 * 750 [CD1] unit 5: what a buyer's list of their own files for review costs
 * (lib/submission-store.ts, buyerSubmissionsFor; the route's "mine"), held
 * below what it pays. The request takes one of the store's public requests
 * before anything is read, as every step of the door does; then, once it
 * knows how many records it will read, mineUnits(n) more, before reading
 * them. At every count from none to MAX_SUBMISSIONS_PER_PERSON, those
 * requests, each priced as a later page (tests/traffic-cost.ts), cost more
 * than the request at its heaviest: its call, CPU and memory, the route's
 * reads before the list, the index and two reads a record, every record and
 * door at its largest through the database, and every record sent on.
 */
import { MAX_SUBMISSIONS_PER_PERSON, MAX_SUBMISSION_RECORD_BYTES } from "@/lib/submission-rules";
import { SUBMISSION_STEP_COMMANDS, mineUnits } from "@/lib/submission-store";
import { DB_BYTE, ORIGIN_PER_BYTE, request } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { done, is, part } from "./check";

/** The route's reads before the list: the store, the listing, the course, the buyer's access and its counts, at the most. */
const BEFORE_COMMANDS = 30;
const BEFORE_BYTES = 1_100_000;
/** A door at its largest (lib/submission-store.ts MAX_DOOR_BYTES) and an index entry, with a path at its longest. */
const DOOR_BYTES = 4_096;
const ENTRY_BYTES = 400;

part("A buyer's list of their files, paid before it is read");
const short: string[] = [];
for (let n = 0; n <= MAX_SUBMISSIONS_PER_PERSON; n += 1) {
  const paid = (1 + mineUnits(n)) * laterPageCost();
  const costs =
    request("heavy", BEFORE_COMMANDS + 1 + 2 * n, BEFORE_BYTES + n * (MAX_SUBMISSION_RECORD_BYTES + DOOR_BYTES + ENTRY_BYTES)) + n * MAX_SUBMISSION_RECORD_BYTES * ORIGIN_PER_BYTE;
  if (paid < costs) short.push(`${n}: ${paid} < ${costs}`);
}
is("at every count, what it pays covers what it costs", short, []);
is("its commands beyond the route's are the index and two a record", SUBMISSION_STEP_COMMANDS.mine, 1 + 2 * MAX_SUBMISSIONS_PER_PERSON);
is("a list of none pays nothing beyond its first request", mineUnits(0), 0);
is("more records never pay less", Array.from({ length: MAX_SUBMISSIONS_PER_PERSON }, (_, i) => mineUnits(i + 1) >= mineUnits(i)).every(Boolean), true);
console.log(`  a list of ${MAX_SUBMISSIONS_PER_PERSON}: ${1 + mineUnits(MAX_SUBMISSIONS_PER_PERSON)} public requests at $${laterPageCost().toFixed(6)}`);

done();
