/**
 * A hand-in's wall time has a line of its own (Claude 1's LOW on #3135, row #3135 of #5285; the coordinator's option
 * (A), 20261123T091431Z-claude-5-ibqho-35a5).
 *
 * A buyer action is priced at the wait shape (SHAPES.wait, ten seconds at 2 GB; UNIT_COST.buyer). A hand-in
 * (app/api/store/course/task/route.ts) can hold its function longer: it waits for the work's lock (oneHandInAtATime,
 * HAND_IN_WAIT_MS), then asks the file store about the file once (headFile) and deletes at most one file (a refused
 * file, a file not handed in, or the one replaced; the ways out are exclusive), each call under BLOB_TIMEOUT_MS. The
 * seconds past the wait shape are priced on the line buyer-actions-hand-in-wall, as if every buyer action of the
 * month were a hand-in. Its seconds are worked out from the constants (AC (ee)), so a change of either one moves the
 * line, and this test fails if the route gains a call the line does not count.
 */
import { readFileSync } from "node:fs";
import { BLOB_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { VERCEL_FUNCTION_GB, VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR } from "@/lib/spend-cost-table";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { COST_LINES, SHAPES, TASK_HAND_IN_SECONDS, TASK_HAND_IN_WAIT_MS } from "./plan-cost-registry";
import { done, is, part } from "./check";

function main(): void {
  part("the hand-in's seconds come from the constants");
  // lib/assignment.ts opens Redis when loaded, so its wait is read from the file and held equal to the registry's copy.
  const assignment = readFileSync("lib/assignment.ts", "utf8");
  const HAND_IN_WAIT_MS = Number(assignment.match(/^(?:export )?const HAND_IN_WAIT_MS = ([0-9_]+);$/m)?.[1]?.replaceAll("_", ""));
  is("the registry's wait is the code's", TASK_HAND_IN_WAIT_MS, HAND_IN_WAIT_MS);
  is("the lock's wait and two file-store calls", TASK_HAND_IN_SECONDS, HAND_IN_WAIT_MS / 1000 + 2 * (BLOB_TIMEOUT_MS / 1000));
  is("longer than the wait shape a buyer action is priced at", TASK_HAND_IN_SECONDS > SHAPES.wait.seconds, true);

  part("the route makes no call the line does not count");
  const route = readFileSync("app/api/store/course/task/route.ts", "utf8");
  is("one head of the file", route.match(/\bheadFile\(/g)?.length, 1);
  is("the hand-in runs inside the work's lock", /oneHandInAtATime\(/.test(route), true);
  is("the lock waits HAND_IN_WAIT_MS", /withLock\(.*HAND_IN_WAIT_MS/.test(assignment), true);

  part("the line prices the seconds past the wait shape for every buyer action");
  const line = COST_LINES.find((each) => each.id === "buyer-actions-hand-in-wall");
  is("the line is there", Boolean(line), true);
  const memorySecond = ((VERCEL_MEMORY_MICRO_USD_PER_GB_HOUR / 1_000_000) * VERCEL_FUNCTION_GB) / 3600;
  for (const tier of ["creator", "pro", "scale"] as const) {
    const expected = STORE_ALLOWANCES[tier].buyer * (TASK_HAND_IN_SECONDS - SHAPES.wait.seconds) * memorySecond;
    is(`${tier}: every buyer action a hand-in held its whole wall`, Math.abs((line?.monthlyUsd(tier) ?? Number.NaN) - expected) < 1e-12, true);
    is(`${tier}: more than nothing`, (line?.monthlyUsd(tier) ?? 0) > 0, true);
  }

  part("the buyer actions' line says where the hand-in's longer wall is priced");
  const buyer = COST_LINES.find((each) => each.id === "buyer-actions");
  is("its basis names the line", buyer?.basis.includes("buyer-actions-hand-in-wall"), true);

  done();
}

main();
