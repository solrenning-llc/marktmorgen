/**
 * What must be built before plan breaks are turned on (Claude 1 coord's triple audit of #5174, 8555). The restart after
 * a break runs only while PLAN_BREAKS_ENABLED (lib/plan-pause-rules.ts) is true, and it is false today. This test fails
 * if the flag is turned on while any condition below is still pending: each one is marked "met" only in the PR that
 * builds it, naming the test or registry line that holds it.
 *
 * (a) The company's fixed-cost line for break restarts in tests/plan-cost-registry.ts, counting every command of a
 *     restart (the store-live-read EVAL included; tests/plan-restart-after-erasure.test.ts counts exactly 1 per POST).
 * (b) A test of the funded restart path: there admit() comes after armRestartSubmission, so an "unknown" read spends the
 *     one submission; the test must show what happens to that grant.
 * (c) The store read again after the POST and, when it is being erased, the new subscription cancelled and its charge
 *     refunded: the read before the POST leaves a one round-trip window.
 */
import { PLAN_BREAKS_ENABLED } from "@/lib/plan-pause-rules";
import { done, is, part } from "./check";

const CONDITIONS: ReadonlyArray<{ id: string; what: string; status: "pending" | "met"; heldBy: string | null }> = [
  { id: "a", what: "the fixed-cost line for break restarts, every command counted", status: "pending", heldBy: null },
  { id: "b", what: "a test of the funded restart path (admit after armRestartSubmission)", status: "pending", heldBy: null },
  { id: "c", what: "the store read again after the POST, cancelled and refunded when erasing", status: "pending", heldBy: null },
];

part("Plan breaks are turned on only once every condition is built");
for (const condition of CONDITIONS) {
  is(`(${condition.id}) ${condition.what}: met, or plan breaks stay off`, PLAN_BREAKS_ENABLED ? condition.status : "met", "met");
  if (condition.status === "met") is(`(${condition.id}) names what holds it`, typeof condition.heldBy === "string" && condition.heldBy.length > 0, true);
}
is("today plan breaks are off", PLAN_BREAKS_ENABLED, false);
done();
