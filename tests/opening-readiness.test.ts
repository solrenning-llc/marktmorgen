/**
 * One list of what opening waits on, read from the gates themselves.
 *
 * lib/opening.ts decides whether a plan can be started with one AND of the
 * owner's request and four gates. lib/opening-readiness.ts lists the same
 * conditions, each with the state its own function returns today, who has
 * to act, and where it lives, so the owner's summary of what is missing
 * (docs/opening-readiness-status-*.md, AV1 step 12) is never typed from
 * memory. These checks fail when the list and lib/opening.ts disagree: a
 * gate added or removed in one and not the other, a state that is not the
 * gate's own answer, or a list that says everything is ready while plans are
 * still closed. Nothing here changes a flag, a review or a record.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLANS_ON_SALE } from "@/lib/opening";
import { commercialPlansMayOpen, CURRENT_COMMERCIAL_MARGIN_REVIEW } from "@/lib/commercial-margin";
import { taxGateValid } from "@/lib/tax-gate";
import { deemedSupplierProblems, deemedSupplierReady } from "@/lib/deemed-supplier";
import { stripePlatformEligibilityReady } from "@/lib/stripe-platform-eligibility";
import { CONTRACT_ADMISSION_COVERAGE, CORE_CONTRACT_ADMISSION_KEYS, CURRENT_CONTRACT_FUNDING_POLICY, contractLifecycleReady } from "@/lib/contract-funding-rules";
import { CURRENT_EXPOSURE_BUDGET_POLICY } from "@/lib/exposure-budget-policy";
import { COMMISSION_LIVE, COMMISSION_PLANS_PUBLISHED } from "@/lib/plan";
import { SHARE_PROVED_IN_TEST_MODE } from "@/lib/platform-share";
import {
  OPENING_GATES,
  COMMERCIAL_REVIEW_PARTS,
  openingReadiness,
  openingReadinessDetails,
} from "@/lib/opening-readiness";
import { done, is, part } from "./check";

const root = process.cwd();
const source = readFileSync(join(root, "lib/opening.ts"), "utf8");

part("The list names exactly the gates lib/opening.ts ANDs together");
const line = source.match(/export const PLANS_ON_SALE: boolean =([^;]+);/);
is("PLANS_ON_SALE is still one expression", line !== null, true);
const called = (line?.[1] ?? "")
  .split("&&")
  .map((term) => term.trim().match(/^([A-Za-z]\w*)\(/)?.[1] ?? `unreadable: ${term.trim()}`);
is("every term of it is a call to a gate", called.every((name) => !name.startsWith("unreadable")), true);
is("the list's gates are those calls, in the same order", OPENING_GATES.map((gate) => gate.check), called);
is("the owner's request goes into the commercial review, as the list says", /commercialPlansMayOpen\(OPENING_REQUESTED\)/.test(line?.[1] ?? ""), true);
is("and OPENING_REQUESTED is declared once, by the owner, in lib/opening.ts", (source.match(/const OPENING_REQUESTED: boolean = (true|false);/g) ?? []).length, 1);

part("Each state is the gate's own answer");
const byId = Object.fromEntries(openingReadiness().map((condition) => [condition.id, condition]));
is("commercial review", byId.commercialReview?.ready, commercialPlansMayOpen(true));
is("tax gate setting", byId.taxGate?.ready, taxGateValid());
is("deemed supplier records", byId.deemedSupplier?.ready, deemedSupplierReady());
is("Stripe platform eligibility", byId.stripePlatform?.ready, stripePlatformEligibilityReady());
is("the deemed-supplier reasons are the gate's own", openingReadinessDetails().deemedSupplierProblems, deemedSupplierProblems());

part("The owner's request is read, never guessed");
const requestedInSource = /const OPENING_REQUESTED: boolean = true;/.test(source);
const others = openingReadiness().filter((condition) => condition.id !== "ownerRequest");
const othersReady = others.every((condition) => condition.ready === true);
const expectedRequest = PLANS_ON_SALE ? true : othersReady ? false : null;
is("on sale means requested; closed with every gate ready means not requested; otherwise unknown from the gates", byId.ownerRequest?.ready, expectedRequest);
is("and it never says requested while the source says false", byId.ownerRequest?.ready === true && !requestedInSource, false);

part("Ready everywhere exactly when plans are on sale");
is("every condition ready ⇔ PLANS_ON_SALE", openingReadiness().every((condition) => condition.ready === true), PLANS_ON_SALE);
if (!PLANS_ON_SALE) {
  const waiting = openingReadiness().filter((condition) => condition.ready !== true);
  is("closed: at least one condition says what it waits on", waiting.length > 0, true);
  is("and each waiting condition names who acts and what it needs", waiting.every((condition) => condition.who.length > 0 && condition.needs.trim().length > 0), true);
}

part("Inside the commercial review");
const parts = Object.fromEntries(openingReadinessDetails().commercialReview.map((row) => [row.id, row]));
is("the parts are listed once each", openingReadinessDetails().commercialReview.map((row) => row.id), COMMERCIAL_REVIEW_PARTS.map((row) => row.id));
is("commission", parts.commission?.ready, !COMMISSION_PLANS_PUBLISHED || (COMMISSION_LIVE && SHARE_PROVED_IN_TEST_MODE));
is("contract lifecycle", parts.contractLifecycle?.ready, contractLifecycleReady());
is("exposure budget policy recorded", parts.exposureBudget?.ready, CURRENT_EXPOSURE_BUDGET_POLICY !== null);
is("contract funding policy recorded", parts.contractFunding?.ready, CURRENT_CONTRACT_FUNDING_POLICY !== null);
is("commercial margin review recorded", parts.marginReview?.ready, CURRENT_COMMERCIAL_MARGIN_REVIEW !== null);
is(
  "the missing core coverages are the false ones in CONTRACT_ADMISSION_COVERAGE",
  openingReadinessDetails().missingCoreCoverage,
  CORE_CONTRACT_ADMISSION_KEYS.filter((key) => CONTRACT_ADMISSION_COVERAGE[key] !== true),
);
is(
  "a ready commercial review never has a part that is not",
  !commercialPlansMayOpen(true) || openingReadinessDetails().commercialReview.every((row) => row.ready === true),
  true,
);

part("The owner's dated summary names every gate");
const summaries = readdirSync(join(root, "docs")).filter((name) => /^opening-readiness-status-\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
is("there is a dated summary", summaries.length > 0, true);
const latest = summaries.length ? readFileSync(join(root, "docs", summaries[summaries.length - 1]), "utf8") : "";
is(
  "the newest one names each gate's function and OPENING_REQUESTED",
  [...OPENING_GATES.map((gate) => gate.check), "OPENING_REQUESTED"].filter((name) => !latest.includes(name)),
  [],
);

done();
