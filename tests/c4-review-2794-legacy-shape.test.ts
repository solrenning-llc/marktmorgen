// Reviewer proof for #2794: records the codebase's own fixtures write ({at, job}, no `items`) and a
// confirmed-absent HGET (null) are now "unknown". Passes on base, fails on the PR head.
import { importedFrom } from "@/lib/imported-purchases";
let failed = 0;
function check(name: string, work: () => void) {
  try { work(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
}
check("a record without `items` (as tests/orders-open.test.ts:365,613 write it) is still a purchase", () => {
  const got = importedFrom(["prod_1", JSON.stringify({ at: 1, job: "api:1" })]);
  if (got.length !== 1 || got[0].productId !== "prod_1") throw new Error(JSON.stringify(got));
});
check("an HGET that answers null (field removed after HKEYS) is no purchase, not unknown (buyer-orders.ts:1473)", () => {
  const got = importedFrom(["prod_1", null]);
  if (got.length !== 0) throw new Error(JSON.stringify(got));
});
console.log(`RESULT ${failed ? "FAIL" : "ok"} ${failed} failed`);
process.exit(failed ? 1 : 0);
