/** Owner SR,27 October2026 08:00 Fortaleza: existing mailbox/registered-agent
 * observations below do not establish a Stripe-accepted real business address
 * or US-resident legal representative. ITIN/acceptance-agent and other required
 * costs remain unknown pending SR3, never zero. See docs/stripe-platform-eligibility.md.
 * Historical observations are preserved; no cost review or release is approved here.
 */
/** FX275, owner22 October2026 05:10Fortaleza. Entire LLC costs, never shared.
 * Native-currency amounts are source observations, not approved USD ceilings.
 * No network, contract or operational activation occurs here.
 */
export const LLC_FIXED_COST_ALLOCATION = { marktmorgenBps: 10000, hazelsongBps: 0, decision: "2026-10-22T05:10:00-03:00" } as const;
/** TX4/SR: cost-review categories, not a claim that every filing/service applies.
 * Each conditional absence needs evidence; unknown cost is never zero.
 * No form, account, submission, paid service or operational IO is prepared here. */
export const LLC_COMPLIANCE_COST_IDS = [
 "us-form-5472", "us-pro-forma-1120", "br-irpf", "br-cbe", "vat-oss-and-local-compliance",
 "itin-and-acceptance-agent", "us-resident-representative", "us-business-address",
] as const;
export const LLC_FIXED_COST_IDS = ["delaware", "california-tax", "california-fee", "registered-agent", "llc-formation", "owner-inss", "domains", "tools", "deployment-artifact-retention", "us-mailbox", "eu-gdpr-representative", "eu-dsa-representative", "uk-gdpr-representative", ...LLC_COMPLIANCE_COST_IDS] as const;
export type FixedCostId = typeof LLC_FIXED_COST_IDS[number];
export type FixedCostCeiling = { id: FixedCostId; fullMonthlyUsdCents: number | null; fullAnnualUsdCents: number | null; evidence: string; reserveReviewed: boolean };
/** Public observations checked22 October2026; discounts/free periods never reduce worst-case cost. */
export const FIXED_COST_SOURCE_OBSERVATIONS = {
 /** Public unit observation, not a reviewed account maximum or retention cap. */
 deploymentArtifacts: { currency: "USD", perGbMonthMinorEach: 10, products: ["Deployment Storage", "Functions Storage"], checked: "2026-10-30", published: "2026-10-09", source: "https://vercel.com/changelog/deployment-storage-pricing-expands-to-existing-teams", approvedCeiling: false },
 delaware: { currency: "USD", annualMinor: 40000, source: "https://corp.delaware.gov/alt-entitytaxinstructions/" },
 californiaTax: { currency: "USD", annualMinor: 80000, source: "https://www.ftb.ca.gov/file/business/types/limited-liability-company/index.html" },
 californiaFee: { currency: "USD", maximumAnnualMinor: 1179000, source: "https://www.ftb.ca.gov/file/business/types/limited-liability-company/index.html" },
 formation: { currency: "USD", initialMinor: 50000, includesGovernmentFees: true, includesFirstAgentYear: true, source: "https://stripe.com/atlas", checked: "2026-10-29" },
 registeredAgent: { currency: "USD", annualMinor: 10000, source: "https://stripe.com/atlas" },
 inss: { currency: "BRL", monthlyMinor: 169511, annualMinor: 2034132, source: "https://www.gov.br/inss/pt-br/direitos-e-deveres/inscricao-e-contribuicao/tabela-de-contribuicao-mensal" },
 mailbox: { currency: "USD", monthlyMinor: 5900, twelveMonthlyPaymentsMinor: 70800, annualInvoiceMinor: 58800, source: "https://www.usestable.com/pricing" },
 representatives: { currency: "EUR", smallMonthlyMinorEach: 7900, smallAnnualMinorEach: 85200, largeMonthlyMinorEach: 44000, largeAnnualMinorEach: 475200, excludesVat: true, source: "https://prighter.com/pricing" },
} as const;
/** No complete reviewed contracts, currency ceilings, taxes and reserve policy exist.
 * Keep every required line explicit and unknown, never omit it or substitute zero.
 */
export const CURRENT_LLC_FIXED_COST_CEILINGS: readonly FixedCostCeiling[] = LLC_FIXED_COST_IDS.map(id => ({id,fullMonthlyUsdCents:null,fullAnnualUsdCents:null,evidence:"",reserveReviewed:false}));
const cents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** Read fixed-cost evidence once from own data properties. Getters, inherited
 * defaults and sparse/accessor array entries are not a reviewed cost record. */
export function allocateEntireLlcFixedCosts(lines: readonly FixedCostCeiling[]) {
 try {
  if (!Array.isArray(lines) || Object.getPrototypeOf(lines) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(lines, "length")?.value;
  if (length !== LLC_FIXED_COST_IDS.length || Reflect.ownKeys(lines).length !== length + 1) return null;
  const keys = ["id", "fullMonthlyUsdCents", "fullAnnualUsdCents", "evidence", "reserveReviewed"] as const;
  const seen = new Set<FixedCostId>();
  let monthly = 0, annual = 0;
  for (let index = 0; index < length; index += 1) {
   const entry = Object.getOwnPropertyDescriptor(lines, String(index));
   if (!entry || !Object.hasOwn(entry, "value")) return null;
   const record: unknown = entry.value;
   if (!record || typeof record !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(record))
    || Reflect.ownKeys(record).length !== keys.length) return null;
   const fields = Object.getOwnPropertyDescriptors(record);
   const data: Record<string, unknown> = Object.create(null);
   for (const key of keys) {
    // A missing cost must not resolve to an inherited descriptor or getter.
    if (!Object.hasOwn(fields, key)) return null;
    const field = fields[key];
    if (!field || !Object.hasOwn(field, "value")) return null;
    data[key] = field.value;
   }
   const id = data.id, month = data.fullMonthlyUsdCents, year = data.fullAnnualUsdCents;
   if (typeof id !== "string" || !(LLC_FIXED_COST_IDS as readonly string[]).includes(id)
    || seen.has(id as FixedCostId) || !cents(month) || !cents(year)
    || data.reserveReviewed !== true || typeof data.evidence !== "string" || !data.evidence.trim()) return null;
   seen.add(id as FixedCostId);
   monthly += month;
   annual += year;
   if (!Number.isSafeInteger(monthly) || !Number.isSafeInteger(annual)) return null;
  }
  return {monthlyUsdCents:monthly,annualUsdCents:annual,marktmorgenBps:LLC_FIXED_COST_ALLOCATION.marktmorgenBps,hazelsongBps:LLC_FIXED_COST_ALLOCATION.hazelsongBps};
 } catch { return null; }
}

/** Generated-report section: unknown complete ceilings block a finite minimum.
 * Per-unit most-tax failures also cannot be repaired by a larger customer count.
 */
export function renderLlcFixedCostStatus(): string {
 const costs=allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS);
 return [
  "## LLC fixed costs — owner decision22 October2026",
  "",
  "Allocation:100% Marktmorgen;0% Hazelsong. Owner22/10/2026 05:10 Fortaleza: \"esqueça Hazelsong\". Historical shared allocations are superseded.",
  "",
  "| Required full LLC cost | Reviewed monthly USD ceiling | Reviewed annual USD ceiling |",
  "| --- | --- | --- |",
  ...CURRENT_LLC_FIXED_COST_CEILINGS.map(line=>`| ${line.id} | ${line.fullMonthlyUsdCents===null?"unknown":line.fullMonthlyUsdCents+" cents"} | ${line.fullAnnualUsdCents===null?"unknown":line.fullAnnualUsdCents+" cents"} |`),
  "",
  costs===null?"Complete fixed-cost total: unknown; rejected, never zero. Minimum paying customer base: not established. Consolidated net margin: not approved.":"Complete fixed-cost ceilings require the separate customer-level and company-base reviews.",
  "MR27Oct requires positive net per unit with existing room; no customer count repairs a zero-profit or losing unit. The full company base remains unestablished while costs are unknown and the commercial review is absent.60%is the actual monthly company target, not a sales gate. No price, visible limit, commission or other launch/tax gate changes.",
  "Native-currency public prices, taxes, eligibility, exchange-rate ceilings and reserve gaps: docs/llc-fixed-costs-2026-10-22.md. A quote or temporary discount is not an approved operating ceiling.",
  "TX4/SR compliance and identity-related costs are explicit review categories, not proof that every filing or paid service applies. Conditional non-applicability needs evidence; unknown remains rejected. Owner INSS remains unresolved pending the remuneration facts and applicable legal reading, not automatically zero or an unconditional fixed liability.",
  "",
 ].join("\n");
}
