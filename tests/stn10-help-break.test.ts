/**
 * 763 [STN10] unit 1, help part: with plan breaks off, the help center's
 * answer to "Can I take a break instead of canceling?" says what canceling
 * leads to, as the studio does (lib/plan-cancel-words.ts), and no longer that
 * buyers keep what they bought with no end: a plan that ends closes its store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { helpAnswer } from "@/lib/help-content";
import { PLAN_BREAKS_ENABLED } from "@/lib/plan-pause-rules";
import { CLOSING_DAYS, closesStore } from "@/lib/plan-closing-rules";

const BREAK = "Can I take a break instead of canceling?";
const ENDS = "What happens when my plan ends?";

test("with breaks off, the answer says the store closes after the plan ends", { skip: PLAN_BREAKS_ENABLED ? "breaks are on: the other answer applies" : false }, () => {
  assert.equal(closesStore(Date.now()), true, "a plan ending today closes its store");
  const answer = helpAnswer(BREAK);
  assert.match(answer, /^Plan breaks are not available\./);
  assert.ok(answer.includes(`your store closes at least ${CLOSING_DAYS} days later`), answer);
  assert.match(answer, /until then your buyers keep access to what they bought/);
  assert.doesNotMatch(answer, /buyers keep access to what they bought\.$/, "never access with no end");
  // It names the answer that says what the closing day removes, and that answer exists.
  assert.ok(answer.includes(`“${ENDS}”`));
  assert.doesNotThrow(() => helpAnswer(ENDS));
});
