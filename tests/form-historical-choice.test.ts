/** Keep the original persisted-answer proof in the ordinary npm test discovery. */
import assert from "node:assert/strict";
import test from "node:test";
import { auditHistoricalChoice } from "./k-form-historical-choice.proof";

test("a retained historical choice remains distinct from a genuinely unanswered question", async () => {
  const report = await auditHistoricalChoice();
  assert.equal(report.checks, 25, "execute all original checks, without copying the proof");
  assert.equal(report.forbiddenFetches, 0);
  assert.deepEqual(report.failures, []);
});
