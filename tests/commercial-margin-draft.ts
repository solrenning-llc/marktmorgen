/**
 * The figures of the commercial margin review draft (docs/opening-readiness/commercial-margin.md, written by hand on
 * 14 November 2026 at main 3859d4a4ef), recomputed from the repository's own modules at whatever commit this runs on.
 * `node scripts/commercial-margin-draft.mjs` writes docs/opening-readiness/commercial-margin-figures.md from
 * renderCommercialMarginDraft().
 *
 * Deliberately no staleness test: a test pinning these amounts would turn every unrelated cost change on main red.
 * Nothing here changes a price, limit, commission, flag, gate or review; it only reads.
 *
 * Only two kinds of figure are typed here, each named below with its source: the LC tax reading and the Amazon SES
 * price. Every other amount comes from lib/ and tests/ modules. Unknown is printed as unknown, never as zero.
 */
import { PLAN_PRICES, PLAN_TITLES, TIERS, COMMISSION_PLANS_PUBLISHED, COMMISSION_LIVE, type Cycle, type Tier } from "@/lib/plan";
import { PROVIDER_FEES, MOST_CORRECT_READING, POSITIVE_NET_CENTS, receivingOf, type Receiving } from "@/lib/receiving-costs";
import {
  BASE_PLAN_REVENUE_CEILINGS, COMMERCIAL_SPEND_FLOOR_ROOM_CENTS, CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_COMMERCIAL_TERMS,
  REQUIRED_MARGIN_SCENARIOS, commercialPlansMayOpen, commercialReviewData,
} from "@/lib/commercial-margin";
import { AUTOMATIC_AI_SPEND_CEILINGS, AUTOMATIC_AI_STORE_MICRO_USD, currentAiSpendPolicy, isAiSpendPolicyValid } from "@/lib/ai-spend-policy";
import { aiEntitlementsFunded, requiredAiStoreMicroUsd } from "@/lib/ai-entitlement-rules";
import { SUPPORTED_AI_MODELS } from "@/lib/ai-request-rules";
import { CURRENT_LLC_FIXED_COST_CEILINGS, LLC_FIXED_COST_ALLOCATION, allocateEntireLlcFixedCosts } from "@/lib/llc-fixed-costs";
import { assessFundedExposure, EXPOSURE_SCOPES } from "@/lib/funded-exposure-rules";
import { assessMinimumCustomerBase } from "@/lib/customer-base-rules";
import { currentUploadBudgetPolicy, isUploadBudgetConfigured } from "@/lib/upload-budget-policy";
import { CURRENT_EXPOSURE_BUDGET_POLICY } from "@/lib/exposure-budget-policy";
import { CONTRACT_ADMISSION_COVERAGE, CORE_CONTRACT_ADMISSION_KEYS, CURRENT_CONTRACT_FUNDING_POLICY, contractLifecycleReady } from "@/lib/contract-funding-rules";
import { SHARE_PROVED_IN_TEST_MODE } from "@/lib/platform-share";
import { VIDEO_CENTS_PER_HOUR_OVER } from "@/lib/watch-rules";
import { openingReadiness, openingReadinessDetails } from "@/lib/opening-readiness";
import { MAX_AUTO_LANGUAGES, MAX_AUTO_MINUTES, MIN_CENTS, CENTS_PER_MINUTE, autoCaptionCents } from "@/lib/auto-captions-rules";
import { ADD_ON_ROOM_CENTS } from "@/lib/store-assistant-rules";
import { COST_LINES, MOVE_COST_UNKNOWNS, NOT_A_COST, PER_EMAIL, perPaymentCost } from "./plan-cost-registry";
import { aiCeilingUsd } from "./plan-cost-model";
import { assistantUnit, captionUnits, planUnits, roomKept, type Unit } from "./margin-alignment-table";
import { MOST_TAX_READING, SIZING_READING, unitUnder as archivedUnitUnder } from "./historical-receiving-model";

/**
 * The LC tax reading (AGENTS.md, rule LC, owner, 1 November 2026, 00:05 Fortaleza; TX point 4 resolved 1 November
 * 2026, 00:10): IRPF 15% on the LLC's profit (Lei 14.754/2023, art. 5), and IOF 0.38% on the money entering Brazil
 * (Decreto 6.306/2007, arts. 14 and 15-B, XXV, conferred on planalto.gov.br on 1 November 2026), whose base is the
 * profit remitted before IRPF. No ISS, no US federal income tax; the buyer's tax is added on top of the price.
 */
export const LC_IRPF_BPS = 1_500;
export const LC_IOF_BPS = 38;
/**
 * Amazon SES at US$0.10 per 1,000 emails (AGENTS.md, rule LC, owner's complement of 1 November 2026, 01:03 and 01:05
 * Fortaleza: "usa o preço real da amazon junto com as proteções"; the account's on-demand price chosen on 30 October
 * 2026). It holds only with the 309 [EM1] protections merged and published; the code still prices PER_EMAIL.
 */
export const SES_PER_EMAIL_USD = 0.10 / 1_000;

/** What depends on the email price, read under whatever PER_EMAIL the bundle carries. */
export type DraftUsage = {
  perEmailUsd: number;
  lines: { id: string; usd: Record<Tier, number> }[];
  perPaymentUsd: Record<Tier, number>;
  /** Usage of each plan unit (id of tests/margin-alignment-table.ts planUnits), in cents. */
  planUsageCents: Record<string, number>;
};

export function commercialMarginUsage(): DraftUsage {
  const byTier = (f: (tier: Tier) => number) => Object.fromEntries(TIERS.map((tier) => [tier, f(tier)])) as Record<Tier, number>;
  return {
    perEmailUsd: PER_EMAIL,
    lines: COST_LINES.map((line) => ({ id: line.id, usd: byTier((tier) => line.monthlyUsd(tier)) })),
    perPaymentUsd: byTier(perPaymentCost),
    planUsageCents: Object.fromEntries(planUnits(false).map((unit) => [unit.id, unit.usageCents])),
  };
}

const ceilBps = (cents: number, bps: number) => Math.ceil((Math.max(0, cents) * bps) / 10_000);
/** The same rounding as tests/margin-alignment-table.ts (centsUp): dollars to whole cents, upward. */
const centsUp = (usd: number) => Math.ceil(Math.round(usd * 1e7) / 1e5);
const usd = (cents: number | null) => cents === null || !Number.isFinite(cents) ? "unknown" : `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dollars4 = (value: number) => !Number.isFinite(value) ? "unknown" : value.toFixed(4);
const yesNo = (value: boolean) => (value ? "yes" : "**no**");

type LcResult = Receiving & { usageCents: number; stripeTaxCents: number; pretaxCents: number; irpfCents: number; iofCents: number; netCents: number };

/** One payment under the LC reading: receiving from lib/receiving-costs.ts, usage, then IRPF and IOF on the pretax profit, each rounded up. */
function lcUnit(priceCents: number, usageCents: number): LcResult {
  const r = receivingOf(priceCents, MOST_CORRECT_READING, true);
  const s = PROVIDER_FEES.stripe;
  const stripeTotal = [s.cardBps, s.internationalBps, s.conversionBps, s.billingBps, s.taxBps].reduce((sum, bps) => sum + ceilBps(r.chargedCents, bps), 0) + s.fixedCents;
  // Stripe Tax is inside the fee only when Stripe is the dearer provider, which providerFeeCents picks.
  const stripeTaxCents = stripeTotal === r.feeCents ? ceilBps(r.chargedCents, s.taxBps) : 0;
  const pretaxCents = r.revenueCents - r.totalCents - usageCents;
  const irpfCents = ceilBps(pretaxCents, LC_IRPF_BPS);
  const iofCents = ceilBps(pretaxCents, LC_IOF_BPS);
  return { ...r, usageCents, stripeTaxCents, pretaxCents, irpfCents, iofCents, netCents: pretaxCents - irpfCents - iofCents };
}

type Row = { name: string; unit: Unit; priceCents: number; lcUsageCents: number; codeUsageCents: number; roomCents: number };

function captionsAtMinimum(): { rows: Row[]; note: string } {
  // The provider's rate per minute and language is not exported by lib/; it is read back from the code's own worst
  // caption units (tests/margin-alignment-table.ts captionUnits: minutes × (languages + 1) × rate), and refused unless
  // every unit gives the same whole rate.
  const worst = captionUnits(false);
  const rates = new Set<number>();
  worst.forEach((unit, index) => {
    const languages = index + 1;
    if (unit.priceCents > MIN_CENTS && unit.priceCents % (languages * CENTS_PER_MINUTE) === 0) {
      const minutes = unit.priceCents / (languages * CENTS_PER_MINUTE);
      rates.add(unit.usageCents / (minutes * (languages + 1)));
    }
  });
  const rate = rates.size === 1 ? Array.from(rates)[0] : null;
  if (rate === null || !Number.isInteger(rate)) return { rows: [], note: "The provider rate per minute and language could not be read back from captionUnits; the $35 rows are unknown." };
  const rows: Row[] = [];
  for (let languages = 1; languages <= MAX_AUTO_LANGUAGES; languages += 1) {
    let minutes = 0;
    for (let m = 1; m <= MAX_AUTO_MINUTES; m += 1) if (autoCaptionCents(m * 60, languages) === MIN_CENTS) minutes = m;
    if (!minutes) continue;
    const usageCents = minutes * (languages + 1) * rate;
    const unit: Unit = { id: `captions-min-${languages}`, name: "", priceCents: MIN_CENTS, usageCents, coreUsageCents: usageCents, ownTransaction: true, onSale: false };
    rows.push({ name: `AI captions at the $${MIN_CENTS / 100} minimum, ${languages} language${languages > 1 ? "s" : ""} (${minutes} min, the longest still at the minimum)`, unit, priceCents: MIN_CENTS, lcUsageCents: usageCents, codeUsageCents: usageCents, roomCents: 0 });
  }
  return { rows, note: `Provider rate read back from captionUnits: ${rate}¢ a minute a language, the spoken language counted once more.` };
}

function allRows(lc: DraftUsage, code: DraftUsage): { rows: Row[]; captionNote: string } {
  const plans = planUnits(false).map((unit): Row => ({
    name: `${PLAN_TITLES[unit.id.split("-")[0] as Tier]} ${unit.id.includes("-year-") ? "yearly" : "monthly"}`,
    unit, priceCents: unit.priceCents, lcUsageCents: lc.planUsageCents[unit.id], codeUsageCents: code.planUsageCents[unit.id], roomCents: roomKept(unit),
  }));
  const assistant = assistantUnit(false);
  const captions = captionsAtMinimum();
  const worstCaptions = captionUnits(false).map((unit): Row => ({ name: `${unit.name} — the code's worst length`, unit, priceCents: unit.priceCents, lcUsageCents: unit.usageCents, codeUsageCents: unit.usageCents, roomCents: roomKept(unit) }));
  return {
    rows: [...plans, { name: assistant.name, unit: assistant, priceCents: assistant.priceCents, lcUsageCents: assistant.usageCents, codeUsageCents: assistant.usageCents, roomCents: roomKept(assistant) }, ...captions.rows, ...worstCaptions],
    captionNote: captions.note,
  };
}

/** Each reason commercialPlansMayOpen(true) is false today, read from the same checks, in its order. */
export function commercialGateReasons(): { check: string; passes: boolean | null; detail: string }[] {
  const out: { check: string; passes: boolean | null; detail: string }[] = [];
  const review = commercialReviewData(CURRENT_COMMERCIAL_MARGIN_REVIEW);
  out.push({ check: "Owner's request (OPENING_REQUESTED, lib/opening.ts)", passes: null, detail: "Private to lib/opening.ts and not read here. This list asks commercialPlansMayOpen(true), as lib/opening-readiness.ts does, so the request is not counted as a reason." });
  out.push({ check: "CURRENT_COMMERCIAL_MARGIN_REVIEW recorded and readable", passes: review !== null, detail: CURRENT_COMMERCIAL_MARGIN_REVIEW === null ? "It is null. commercialPlansMayOpen returns false at this step; every check below is what a review would still meet." : "Recorded." });
  out.push({ check: "Commission: none published, or live and proved", passes: !COMMISSION_PLANS_PUBLISHED || (COMMISSION_LIVE && SHARE_PROVED_IN_TEST_MODE), detail: `COMMISSION_PLANS_PUBLISHED=${COMMISSION_PLANS_PUBLISHED}.` });
  out.push({ check: "Exposure budget policy configured", passes: CURRENT_EXPOSURE_BUDGET_POLICY !== null && review !== null, detail: `CURRENT_EXPOSURE_BUDGET_POLICY is ${CURRENT_EXPOSURE_BUDGET_POLICY === null ? "null" : "recorded"}.` });
  out.push({ check: "Contract funding policy configured", passes: CURRENT_CONTRACT_FUNDING_POLICY !== null && review !== null, detail: `CURRENT_CONTRACT_FUNDING_POLICY is ${CURRENT_CONTRACT_FUNDING_POLICY === null ? "null" : "recorded"}.` });
  const missing = CORE_CONTRACT_ADMISSION_KEYS.filter((key) => CONTRACT_ADMISSION_COVERAGE[key] !== true);
  out.push({ check: "Contract life cycle covered (contractLifecycleReady)", passes: contractLifecycleReady(), detail: missing.length ? `Core keys still false: ${missing.join(", ")}.` : "Every core key is true." });
  out.push({ check: "Upload budget policy configured", passes: isUploadBudgetConfigured(currentUploadBudgetPolicy()), detail: "currentUploadBudgetPolicy()." });
  const ai = currentAiSpendPolicy();
  const aiValid = isAiSpendPolicyValid(ai);
  const aiFunded = aiValid && aiEntitlementsFunded(ai);
  const aiDetail = (["creator", "pro", "scale"] as const).map((tier) => {
    const required = requiredAiStoreMicroUsd(tier, AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd);
    return `${PLAN_TITLES[tier]} ceiling ${usd(Math.ceil(AUTOMATIC_AI_STORE_MICRO_USD[tier] / 10_000))} a month against ${required === null ? "unknown" : usd(Math.ceil(Number(required) / 10_000))} for every right at the largest request`;
  }).join("; ");
  out.push({ check: "AI spend policy valid and every AI right funded (aiEntitlementsFunded)", passes: aiFunded, detail: `${aiDetail}.` });
  const largest = Math.max(...SUPPORTED_AI_MODELS.map((model) => AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd[model]));
  const short = (["creator", "pro", "scale"] as const).filter((tier) => (ai?.storeMicroUsd[tier] ?? -1) < largest);
  out.push({ check: "Every plan's AI ceiling at least the largest single request (lib/commercial-margin.ts, the upload/AI pool check)", passes: short.length === 0, detail: short.length ? `Fails for ${short.map((tier) => `${PLAN_TITLES[tier]} (${ai?.storeMicroUsd[tier] ?? "unknown"} µUSD)`).join(", ")} against ${largest.toLocaleString("en-US")} µUSD. No customer count passes it; it needs a code decision.` : "Every plan passes." });
  const llc = allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS);
  const unknownLines = CURRENT_LLC_FIXED_COST_CEILINGS.filter((line) => line.fullMonthlyUsdCents === null || line.fullAnnualUsdCents === null).length;
  out.push({ check: "Every LLC fixed-cost line has a reviewed ceiling", passes: llc !== null, detail: `${unknownLines} of ${CURRENT_LLC_FIXED_COST_CEILINGS.length} lines are null; allocateEntireLlcFixedCosts returns ${llc === null ? "null" : "a total"}.` });
  const exposure = assessFundedExposure(review?.fundedExposure ?? null);
  out.push({ check: "Funded exposure approved (assessFundedExposure)", passes: exposure.approved, detail: `Reason: ${exposure.reason}; ${EXPOSURE_SCOPES.length} scopes (${EXPOSURE_SCOPES.join(", ")}).` });
  const base = assessMinimumCustomerBase(Object.keys(BASE_PLAN_REVENUE_CEILINGS).map((key) => ({ months: key.includes("_year_") ? 12 as const : 1 as const, scenario: null })), review?.companyBase ?? null);
  out.push({ check: "Minimum customer base sufficient (assessMinimumCustomerBase)", passes: base.reviewedBaseSufficient, detail: `Status: ${base.status}.` });
  const overages = REQUIRED_MARGIN_SCENARIOS.filter((key) => BASE_PLAN_REVENUE_CEILINGS[key] === undefined);
  out.push({ check: "All required scenarios approved, including the overage ones", passes: review === null || overages.length > 0 ? false : null, detail: `${review === null ? "No review, so no scenario is approved. " : ""}${overages.join(", ")} are still required. In CURRENT_COMMERCIAL_TERMS, traffic overage is "${CURRENT_COMMERCIAL_TERMS.traffic.overage}" and orders overage "${CURRENT_COMMERCIAL_TERMS.orders.overage}"; the video overage price (${VIDEO_CENTS_PER_HOUR_OVER}¢ an hour) is historical, never charged since 31 October 2026 (lib/watch-rules.ts). A scenario with no collected revenue is refused, so these cannot pass as overage revenue.` });
  return out;
}

export type DraftOptions = { lcUsage?: DraftUsage | null; commit?: string; date?: string };

export function renderCommercialMarginDraft(options: DraftOptions = {}): string {
  const code = commercialMarginUsage();
  const sesApplied = !!options.lcUsage && options.lcUsage.perEmailUsd === SES_PER_EMAIL_USD;
  const lc = sesApplied ? options.lcUsage! : code;
  const { rows, captionNote } = allRows(lc, code);
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push("# Commercial margin figures — generated, for the owner");
  push("");
  push(`<!-- Generated by node scripts/commercial-margin-draft.mjs from tests/commercial-margin-draft.ts. No figure is edited by hand. -->`);
  push("");
  push(`Generated at main \`${options.commit ?? "unknown commit"}\` on ${options.date ?? "an unknown date"}. The figures are the repository's own model at that commit. They are not invoices, not an approved review and not a certified profit.`);
  push("");
  push("> **Nothing here is approved or opened.** `CURRENT_COMMERCIAL_MARGIN_REVIEW` stays `null`. No price, limit, commission, flag, tax gate, Article 9a gate or review changes. This replaces only the figures of the hand-written draft `docs/opening-readiness/commercial-margin.md` (main `3859d4a4ef`, 14 November 2026), which are stale.");
  push("");
  push("## How it is computed");
  push("");
  push(`- **Use:** every cost line of \`tests/plan-cost-registry.ts\` at 100% of every right in the worst month. A yearly payment carries 12 worst months plus what one payment leaves after the plan ends, as \`planUnits\` in \`tests/margin-alignment-table.ts\` models it. The commission on sales counts as zero.`);
  push(`- **Receiving:** \`lib/receiving-costs.ts\`. The buyer's tax is added on top of the price at up to ${MOST_CORRECT_READING.salesTaxOnTopBps / 100}%. The dearer provider's fee is taken on the whole amount charged. Remittance ${MOST_CORRECT_READING.remittanceBps / 100}%, refund reserve 1%, dispute reserve 1% of (amount charged + both dispute fees).`);
  push(`- **Tax-collection cost:** Stripe Tax is modelled as ${PROVIDER_FEES.stripe.taxBps / 100}% of the amount charged inside the Stripe fee (\`PROVIDER_FEES.stripe.taxBps\`); the column shows that share. Stripe Tax at a fixed fee per transaction: **not modelled**. Per-sale EU VAT/OSS (IV1) or UK VAT collection costs: **not modelled** in \`lib/receiving-costs.ts\` or the registry, so unknown, never zero. VAT/OSS registration and filing are the LLC fixed-cost line \`vat-oss-and-local-compliance\`, which is null.`);
  push(`- **LC reading (the owner's profit, rule LC):** IRPF ${LC_IRPF_BPS / 100}% of the pretax profit (Lei 14.754/2023, art. 5) and IOF ${LC_IOF_BPS / 100}% of the amount remitted, taken as the pretax profit (Decreto 6.306/2007, arts. 14 and 15-B, XXV). Each is rounded up to the cent. No ISS, no US federal income tax. This is computed outside the 27.5% floor, which now lives only in \`tests/historical-receiving-model.ts\`.${LC_IRPF_BPS === MOST_CORRECT_READING.profitTaxBps && LC_IOF_BPS === MOST_CORRECT_READING.incomingExchangeIofBps ? " The code's `MOST_CORRECT_READING` holds the same two rates." : " **The code's `MOST_CORRECT_READING` holds different rates.**"}`);
  push(sesApplied
    ? `- **Email (LC):** Amazon SES at $${(SES_PER_EMAIL_USD * 1_000).toFixed(2)} per 1,000 ($${SES_PER_EMAIL_USD} per email), swapped for the code's \`PER_EMAIL\` ($${code.perEmailUsd} per email) everywhere the registry uses it. It holds only once the 309 [EM1] protections are merged and published. The Resend Pro subscription then becomes an LLC fixed cost (\`tools\`, null today), never zero.`
    : `- **Email:** the SES price was **not** swapped in (no SES usage was supplied), so the LC column uses the code's \`PER_EMAIL\` ($${code.perEmailUsd} per email).`);
  push(`- **Room:** the spend-floor room (${COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.month}¢ monthly, ${COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.year}¢ yearly, ${ADD_ON_ROOM_CENTS}¢ for the assistant, none for captions) is charged as a cost before tax. "Net after room" is the result of that. A unit is **positive** when it keeps at least ${POSITIVE_NET_CENTS}¢ after room (rule MR).`);
  push(`- **AI** in the plan rows is held at the automatic monthly ceiling (\`AUTOMATIC_AI_STORE_MICRO_USD\`), as the registry's \`ai\` line does. The section after the tables shows every AI right at its largest request.`);
  push("");

  push("## Result per unit — LC reading");
  push("");
  push("Amounts per payment, US dollars.");
  push("");
  push("| Unit | Price | Charged (with buyer tax) | Revenue | Fee | of which Stripe Tax | Remittance | Refund reserve | Dispute reserve | Use (100%) | Pretax | IRPF | IOF | Net | Room | Net after room | Result |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const r = lcUnit(row.priceCents, row.lcUsageCents);
    const after = lcUnit(row.priceCents, row.lcUsageCents + row.roomCents);
    push(`| ${row.name} | ${usd(row.priceCents)} | ${usd(r.chargedCents)} | ${usd(r.revenueCents)} | ${usd(r.feeCents)} | ${usd(r.stripeTaxCents)} | ${usd(r.remittanceCents)} | ${usd(r.refundReserveCents)} | ${usd(r.disputeReserveCents)} | ${usd(r.usageCents)} | ${usd(r.pretaxCents)} | ${usd(r.irpfCents)} | ${usd(r.iofCents)} | ${usd(r.netCents)} | ${usd(row.roomCents)} | ${usd(after.netCents)} | ${after.netCents >= POSITIVE_NET_CENTS ? "positive" : "**negative**"} |`);
  }
  push("");
  push(captionNote);
  push("");

  push("## The same units under the code's readings");
  push("");
  push(`Net after room, with the code's email price ($${code.perEmailUsd} per email). "Code's model" is \`tests/margin-alignment-table.ts\` \`unitUnder\` (IRPF and IOF together, ${(MOST_CORRECT_READING.profitTaxBps + MOST_CORRECT_READING.incomingExchangeIofBps) / 100}% on profit, rounded once). The last two columns are **archived readings, not the owner's profit**, from \`tests/historical-receiving-model.ts\`: "${SIZING_READING.label}" and "${MOST_TAX_READING.label}". Both carry the 27.5% floor.`);
  push("");
  push("| Unit | LC (for comparison) | Code's model, code email | Archived: sizing 27.5% | Archived: most-tax |");
  push("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const lcAfter = lcUnit(row.priceCents, row.lcUsageCents + row.roomCents).netCents;
    const cents = (reading: typeof SIZING_READING) => archivedUnitUnder(row.priceCents, row.codeUsageCents + row.roomCents, reading, true).netCents;
    const codeModel = (() => { const r = receivingOf(row.priceCents, MOST_CORRECT_READING, true); const pre = r.revenueCents - r.totalCents - row.codeUsageCents - row.roomCents; return pre - ceilBps(pre, MOST_CORRECT_READING.profitTaxBps + MOST_CORRECT_READING.incomingExchangeIofBps); })();
    push(`| ${row.name} | ${usd(lcAfter)} | ${usd(codeModel)} | ${usd(cents(SIZING_READING))} | ${usd(cents(MOST_TAX_READING))} |`);
  }
  push("");

  push("## Cost lines per worst month");
  push("");
  push(`From \`COST_LINES\` in \`tests/plan-cost-registry.ts\`, US dollars. Lines that move with the email price show the SES figure, then the code's.`);
  push("");
  push(`| Cost line | ${TIERS.map((tier) => PLAN_TITLES[tier]).join(" | ")} |`);
  push(`| --- | ${TIERS.map(() => "---").join(" | ")} |`);
  const codeById = new Map(code.lines.map((line) => [line.id, line.usd]));
  for (const line of lc.lines) {
    const other = codeById.get(line.id)!;
    push(`| ${line.id} | ${TIERS.map((tier) => line.usd[tier] === other[tier] || !sesApplied ? dollars4(line.usd[tier]) : `${dollars4(line.usd[tier])} (code ${dollars4(other[tier])})`).join(" | ")} |`);
  }
  const total = (u: DraftUsage, tier: Tier) => u.lines.reduce((sum, line) => sum + line.usd[tier], 0);
  push(`| **Total per worst month** | ${TIERS.map((tier) => sesApplied ? `**${dollars4(total(lc, tier))}** (code ${dollars4(total(code, tier))})` : `**${dollars4(total(code, tier))}**`).join(" | ")} |`);
  push(`| What one payment leaves after the plan ends (once per payment) | ${TIERS.map((tier) => sesApplied && lc.perPaymentUsd[tier] !== code.perPaymentUsd[tier] ? `${dollars4(lc.perPaymentUsd[tier])} (code ${dollars4(code.perPaymentUsd[tier])})` : dollars4(code.perPaymentUsd[tier])).join(" | ")} |`);
  const nonFinite = lc.lines.filter((line) => TIERS.some((tier) => !Number.isFinite(line.usd[tier]))).map((line) => line.id);
  push("");
  push(nonFinite.length ? `Lines with no finite figure (unknown, they fail): ${nonFinite.join(", ")}.` : "Every registry line has a finite figure. That does not make every cost known: see \"Unknown, never zero\" below.");
  push("");

  push("## Studio and Scale with every AI right used");
  push("");
  push("`aiEntitlementsFunded` prices every permitted call at the largest request the code allows (`AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd`). The automatic ceiling stops spending before that, so no loss happens today; the gate fails because the published rights are not funded. \"Haiku only\" assumes two code changes: Haiku as the only allowed model and the ceiling raised to fund every right. LC reading, SES email, net after room, per payment.");
  push("");
  push("| Unit | AI ceiling today (a month) | All AI rights, largest request (a month) | All AI rights, Haiku only (a month) | Net after room, ceiling | Net after room, all rights | Net after room, Haiku only |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  const haiku = AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd["claude-haiku-5-5"];
  for (const tier of ["pro", "scale"] as const) {
    const full = requiredAiStoreMicroUsd(tier, AUTOMATIC_AI_SPEND_CEILINGS.requestMicroUsd);
    const haikuOnly = requiredAiStoreMicroUsd(tier, { "claude-sonnet-5-5": haiku, "claude-haiku-5-5": haiku });
    for (const cycle of ["month", "year"] as Cycle[]) {
      const months = cycle === "year" ? 12 : 1;
      const room = cycle === "year" ? COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.year : COMMERCIAL_SPEND_FLOOR_ROOM_CENTS.month;
      const monthly = total(lc, tier);
      const usageWith = (aiUsd: number | null) => aiUsd === null ? null : centsUp(months * (monthly - aiCeilingUsd(tier) + aiUsd) + lc.perPaymentUsd[tier]);
      const net = (usage: number | null) => usage === null ? null : lcUnit(PLAN_PRICES[tier][cycle], usage + room).netCents;
      const fullUsd = full === null ? null : Number(full) / 1_000_000;
      const haikuUsd = haikuOnly === null ? null : Number(haikuOnly) / 1_000_000;
      const mark = (cents: number | null) => cents === null ? "unknown" : cents >= POSITIVE_NET_CENTS ? usd(cents) : `**${usd(cents)}**`;
      push(`| ${PLAN_TITLES[tier]} ${cycle === "year" ? "yearly" : "monthly"} | ${usd(Math.ceil(aiCeilingUsd(tier) * 100))} | ${fullUsd === null ? "unknown" : usd(Math.ceil(fullUsd * 100))} | ${haikuUsd === null ? "unknown" : usd(Math.ceil(haikuUsd * 100))} | ${mark(net(usageWith(aiCeilingUsd(tier))))} | ${mark(net(usageWith(fullUsd)))} | ${mark(net(usageWith(haikuUsd)))} |`);
    }
  }
  push("");
  push(`Store has no AI rights (ceiling ${usd(Math.ceil(AUTOMATIC_AI_STORE_MICRO_USD.creator / 10_000))}). AI amounts are rounded up to the cent.`);
  push("");

  push("## Why `commercialPlansMayOpen(true)` is false today");
  push("");
  push(`\`commercialPlansMayOpen(true)\` returns **${commercialPlansMayOpen(true)}**. Each check, read from the code:`);
  push("");
  push("| Check | Passes | Detail |");
  push("| --- | --- | --- |");
  for (const reason of commercialGateReasons()) push(`| ${reason.check} | ${reason.passes === null ? "not read" : yesNo(reason.passes)} | ${reason.detail} |`);
  push("");
  push("The other opening gates (not part of the commercial review), from `openingReadiness()` in `lib/opening-readiness.ts`:");
  push("");
  push("| Gate | Ready | Who acts |");
  push("| --- | --- | --- |");
  for (const gate of openingReadiness()) if (gate.id !== "commercialReview" && gate.id !== "ownerRequest") push(`| ${gate.id} (${gate.where}) | ${gate.ready === null ? "not known" : yesNo(gate.ready)} | ${gate.who} |`);
  const details = openingReadinessDetails();
  if (details.deemedSupplierProblems.length) { push(""); push(`Deemed-supplier problems: ${details.deemedSupplierProblems.length} (\`deemedSupplierProblems()\`).`); }
  push("");

  push("## LLC fixed costs and the minimum customer base");
  push("");
  push(`Allocation: ${LLC_FIXED_COST_ALLOCATION.marktmorgenBps / 100}% Marktmorgen, ${LLC_FIXED_COST_ALLOCATION.hazelsongBps / 100}% Hazelsong (FX275). ${CURRENT_LLC_FIXED_COST_CEILINGS.length} lines in \`CURRENT_LLC_FIXED_COST_CEILINGS\`:`);
  push("");
  push("| Line | Reviewed monthly ceiling | Reviewed annual ceiling |");
  push("| --- | --- | --- |");
  const ceiling = (cents: number | null) => cents === null ? "unknown, fails" : usd(cents);
  for (const line of CURRENT_LLC_FIXED_COST_CEILINGS) push(`| ${line.id} | ${ceiling(line.fullMonthlyUsdCents)} | ${ceiling(line.fullAnnualUsdCents)} |`);
  push("");
  const llc = allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS);
  const exposure = assessFundedExposure(commercialReviewData(CURRENT_COMMERCIAL_MARGIN_REVIEW)?.fundedExposure ?? null);
  push(llc === null || !exposure.approved
    ? `**Minimum paying customer base: not calculable.** ${llc === null ? "At least one fixed-cost line is null, so the complete total is unknown." : ""} ${exposure.approved ? "" : `The funded-exposure review is ${exposure.reason}.`} Public price observations in \`FIXED_COST_SOURCE_OBSERVATIONS\` (\`lib/llc-fixed-costs.ts\`) are quotes, not reviewed ceilings.`
    : `Fixed costs: ${usd(llc.monthlyUsdCents)} a month. The minimum base still needs the reviewed scenarios.`);
  push("");
  const storeMonthly = rows.find((row) => row.unit.id === "creator-month-list");
  if (storeMonthly) {
    const per = lcUnit(storeMonthly.priceCents, storeMonthly.lcUsageCents + storeMonthly.roomCents).netCents;
    const scale = (cents: number) => per > 0 ? Math.ceil(cents / per) : null;
    push(`For scale only, not a base: the code allows no tax shield on fixed costs, so each $1,000 a month of fixed costs and funded exposure needs the LC net after room of at least ${scale(100_000) ?? "unknown"} Store monthly customers.`);
    push("");
  }

  push("## Unknown, never zero");
  push("");
  push(`- Every LLC fixed-cost line above (${CURRENT_LLC_FIXED_COST_CEILINGS.filter((line) => line.fullMonthlyUsdCents === null).length} null), and every residual cost of the stored Hazelsong the LLC pays (FX275, HZ).`);
  push(`- Company costs the registry keeps out of plan lines (\`NOT_A_COST\`, ${Object.keys(NOT_A_COST).length} entries) and the account-move unknowns (\`MOVE_COST_UNKNOWNS\`, ${MOVE_COST_UNKNOWNS.length}): not yet LLC fixed-cost lines.`);
  push("- Stripe's tariff per API call and PayPal's per API call: no dated source in the registry.");
  push("- Human support: no cost line.");
  push("- Per-sale EU VAT/OSS (IV1) and UK VAT collection costs; Stripe Tax as a fixed fee per transaction.");
  push(`- Funded exposure (${EXPOSURE_SCOPES.join(", ")}): no review.`);
  push("- The TX review per scenario (FX ceilings, annual books, incoming exchange operations): none exists before the LLC operates.");
  push("- Real invoices, the Vercel project's region, the Bunny Stream network and today's SES and Resend prices: not checked by this generator.");
  push("");
  push("State (VR item 1): a generated document. Nothing is available to customers and nothing is opened.");
  push("");
  return out.join("\n");
}
