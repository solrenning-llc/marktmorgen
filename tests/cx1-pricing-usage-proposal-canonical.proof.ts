import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * The pricing and usage proposal of 18 October 2026
 * (docs/pricing-usage-proposal-2026-10-18.md): a PROPOSAL, no price, limit or
 * gate in code changes. The document must be what
 * tests/pricing-usage-proposal-table.ts renders today (regenerate it with
 * `node scripts/pricing-usage-proposal.mjs`), and every figure it proposes
 * must do what it says, under the repository's own margin code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { LEGACY_PLAN_PRICES, PLAN_PRICES, TIERS } from "@/lib/plan";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { MOST_TAX_READING } from "./historical-margin-model";
import { ORDER, figures } from "./limits-proposal-table";
import {
  COMPETITORS, KEPT_IN_FULL, MIN_INCLUDED_SHARE, PACKS, PRICES_BEFORE_553, RAISED_BY_553, figuresBefore553, grid, packUnit, planAt,
  recommended, renderPricingUsageProposal, wholeCustomer, yearOf,
} from "./pricing-usage-proposal-table";

const DOC = "docs/pricing-usage-proposal-2026-10-18.md";
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("the document is what the numbers render today (run node scripts/pricing-usage-proposal.mjs)", () => {
  assert.equal(read(DOC), renderPricingUsageProposal(), `${DOC} is stale: run node scripts/pricing-usage-proposal.mjs`);
  assert.ok(read(DOC).startsWith(HISTORICAL_MARGIN_NOTICE));
  assert.match(read(DOC).slice(HISTORICAL_MARGIN_NOTICE.length), /^# Entry prices with usage packs: a proposal, 18 October 2026/);
  assert.match(read(DOC), /\*\*A proposal for the owner, not a change\.\*\*/);
});

