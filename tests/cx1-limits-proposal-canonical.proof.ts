import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * The limits proposal of 18 October 2026 (docs/limits-proposal-2026-10-18.md):
 * a PROPOSAL, no limit in code changes. The document must be what
 * tests/limits-proposal-table.ts renders today (regenerate it with
 * `node scripts/limits-proposal.mjs`), and every figure it proposes must
 * do what it says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { receivingOf } from "@/lib/receiving-costs";
import { reviewedUnitUnder } from "@/lib/reviewed-receiving";
import { txCustomerFixture } from "./customer-tax-review-fixture";
import { ASSISTANT_INPUT_BYTES } from "@/lib/store-assistant-rules";
import { CENTS_PER_MINUTE, MIN_CENTS } from "@/lib/auto-captions-rules";
import { ORDER, assistantAt, assistantInputCap, captionsMinimumFor, captionsOptions, captionsPrice, captionsTodayAnyMinimum, captionsWorstBps, figures, perMinuteHolds, proposals, renderLimitsProposal } from "./limits-proposal-table";

const DOC = "docs/limits-proposal-2026-10-18.md";
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today (run node scripts/limits-proposal.mjs)", () => {
  assert.equal(read(DOC), renderLimitsProposal(PLANS_ON_SALE, PLANS_ON_SALE), `${DOC} is stale: run node scripts/limits-proposal.mjs`);
  assert.ok(read(DOC).startsWith(HISTORICAL_MARGIN_NOTICE));
  assert.match(read(DOC).slice(HISTORICAL_MARGIN_NOTICE.length), /^# Limits proposal, 18 October 2026 — a PROPOSAL, nothing here is in force/);
});

