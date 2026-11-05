import { HISTORICAL_MARGIN_NOTICE } from "./historical-margin-model";
/**
 * Prices and limits that maximize the owner's profit under stated demand
 * scenarios (18 October 2026): an ANALYSIS for the owner, not a change. No
 * price, limit, gate or tax assumption in code changes, and sales stay
 * closed.
 *
 * Inputs:
 *   - docs/pricing-optimization-data-2026-10-18.json: the competitors read on
 *     READ_ON, each figure with its page; nothing estimated;
 *   - the repository's own margin code: lib/receiving-costs.ts (unitUnder,
 *     the sizing and most-tax readings), tests/limits-proposal-table.ts
 *     (usageCents, figures, tidy, ORDER), lib/customer-base-rules.ts
 *     (assessMinimumCustomerBase), tests/pack-cost-decomposition-table.ts
 *     (creditOption).
 *
 * The optimization: a mixed-integer program (scripts/pricing-optimization-milp.py,
 * scipy.optimize.milp with HiGHS) chooses each plan's monthly price on a $X9
 * grid and the share of each #553 per-use figure, under constant-elasticity
 * demand scenarios. Its input is written by this file
 * (milpInput, docs/pricing-optimization-milp-input-2026-10-18.json), and
 * every solution it returns (docs/pricing-optimization-milp-output-2026-10-18.json)
 * is checked here against the repository's own margin code and against an
 * exhaustive search over the same grid.
 *
 *   node scripts/pricing-optimization.mjs
 *
 * writes the input, runs the solver and writes docs/pricing-optimization-2026-10-18.md;
 * tests/pricing-optimization.test.ts fails when any of the three files is
 * stale or a solution stops keeping 60%.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_PRICES, PLAN_TITLES, TIERS, monthlyEmails, type Cycle, type Tier } from "@/lib/plan";
import { MAX_LEADS } from "@/lib/contact-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_TEAM } from "@/lib/team";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { TOP_HEIGHT, viewingBytes } from "@/lib/stream-rules";
import { assessMinimumCustomerBase } from "./historical-margin-model";
import { MOST_TAX_READING, SIZING_READING, unitUnder, type UnitResult } from "./historical-margin-model";
import { ORDER, figures, tidy, usageCents, type Printed } from "./limits-proposal-table";
import { FETCHED_AHEAD, GB, PER_EMAIL } from "./plan-cost-registry";
import { CREDIT_AMOUNTS, creditOption } from "./pack-cost-decomposition-table";

export const READ_ON = "18 October 2026";
export const DATA_FILE = "docs/pricing-optimization-data-2026-10-18.json";
export const INPUT_FILE = "docs/pricing-optimization-milp-input-2026-10-18.json";
export const OUTPUT_FILE = "docs/pricing-optimization-milp-output-2026-10-18.json";
export const DOC_FILE = "docs/pricing-optimization-2026-10-18.md";

const root = () => process.cwd();
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(root(), file), "utf8")) as T;

// ------------------------------------------------------------- the dataset

type Limit = number | "unlimited" | null;
export type CompetitorPlan = {
  vendor: string; plan: string; rank: number;
  monthUsd: number | null; yearUsd: number | null; yearMonthlyEqUsd: number | null;
  feePct: number | null; feeIncludesProcessing: boolean;
  emailIncluded: 0 | 1; emailsMonth: Limit; contacts: Limit; storageGB: Limit; videoBandwidthGB: Limit; seats: Limit; products: Limit;
  aiIncluded: 0 | 1; sources: string[]; caveat?: string;
};
export type Dataset = {
  readOn: string; note: string;
  sources: { id: string; url: string; read: string; type: string }[];
  brand: { vendor: string; evidence: string; source: string | null; sourceType: string }[];
  plans: CompetitorPlan[];
  feeOnly: { vendor: string; what: string; source: string }[];
};
let cached: Dataset | null = null;
export const dataset = (): Dataset => (cached ??= readJson<Dataset>(DATA_FILE));

/** The price a plan is set beside: billed monthly where the page states it, else its yearly price a month. */
export function bandPrice(p: CompetitorPlan): number {
  if (p.monthUsd !== null) return p.monthUsd;
  if (p.yearMonthlyEqUsd !== null) return p.yearMonthlyEqUsd;
  return p.yearUsd! / 12;
}
/** The cheapest way to pay for a month, as the page states it. */
export function lowestMonthly(p: CompetitorPlan): number {
  return Math.min(...[p.monthUsd, p.yearMonthlyEqUsd, p.yearUsd === null ? null : p.yearUsd / 12].filter((n): n is number => n !== null));
}
/** The three price bands, by the competitor plan's price a month: a rule, stated in the document. */
export const BANDS: Record<Tier, { from: number; to: number }> = {
  creator: { from: 0, to: 60 },
  pro: { from: 60, to: 230 },
  scale: { from: 230, to: Number.POSITIVE_INFINITY },
};
export function band(tier: Tier): CompetitorPlan[] {
  const b = BANDS[tier];
  return dataset().plans.filter((p) => bandPrice(p) >= b.from && bandPrice(p) < b.to);
}
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** The demand anchor: the median price of the plan's band, in cents. */
export const anchorCents = (tier: Tier) => Math.round(median(band(tier).map(bandPrice)) * 100);

// ------------------------------------------------------------- statistics

type Matrix = number[][];
const transpose = (a: Matrix): Matrix => a[0].map((_, j) => a.map((row) => row[j]));
const mul = (a: Matrix, b: Matrix): Matrix => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
function inverse(a: Matrix): Matrix {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) throw new Error("singular design matrix");
    [m[c], m[pivot]] = [m[pivot], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j += 1) m[c][j] /= d;
    for (let r = 0; r < n; r += 1) if (r !== c) { const f = m[r][c]; for (let j = 0; j < 2 * n; j += 1) m[r][j] -= f * m[c][j]; }
  }
  return m.map((row) => row.slice(n));
}
function lnGamma(x: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i += 1) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function betacf(a: number, b: number, x: number): number {
  let c = 1, d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d);
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; d = 1 / (Math.abs(d) < 1e-30 ? 1e-30 : d); c = 1 + aa / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h;
}
function incBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student's t two-sided p-value and the 97.5% quantile, for the regression's confidence intervals. */
export const tTwoSidedP = (t: number, df: number) => incBeta(df / 2, 0.5, df / (df + t * t));
export function tQuantile975(df: number): number {
  let lo = 0, hi = 50;
  for (let i = 0; i < 200; i += 1) { const mid = (lo + hi) / 2; if (tTwoSidedP(mid, df) > 0.05) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export type Ols = { names: string[]; n: number; k: number; beta: number[]; se: number[]; t: number[]; p: number[]; ciLow: number[]; ciHigh: number[]; r2: number; adjR2: number };
/** Ordinary least squares with heteroskedasticity-robust (HC1) standard errors. */
export function ols(y: number[], x: Matrix, names: string[]): Ols {
  const n = y.length, k = x[0].length;
  const xt = transpose(x);
  const xtxInv = inverse(mul(xt, x));
  const beta = mul(xtxInv, mul(xt, y.map((v) => [v]))).map((r) => r[0]);
  const fitted = x.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const e = y.map((v, i) => v - fitted[i]);
  const meat = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => x.reduce((s, row, i) => s + e[i] * e[i] * row[a] * row[b], 0)));
  const cov = mul(mul(xtxInv, meat), xtxInv).map((row) => row.map((v) => (v * n) / (n - k)));
  const se = cov.map((row, i) => Math.sqrt(row[i]));
  const df = n - k;
  const q = tQuantile975(df);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const ssr = e.reduce((s, v) => s + v * v, 0), sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const r2 = 1 - ssr / sst;
  const t = beta.map((b, i) => b / se[i]);
  return { names, n, k, beta, se, t, p: t.map((v) => tTwoSidedP(Math.abs(v), df)), ciLow: beta.map((b, i) => b - q * se[i]), ciHigh: beta.map((b, i) => b + q * se[i]), r2, adjR2: 1 - ((1 - r2) * (n - 1)) / df };
}

export const REGRESSORS = ["constant", "tier rank within the vendor", "fee on a sale, %", "fee not stated", "email marketing listed", "AI listed"] as const;
const row = (p: CompetitorPlan) => [1, p.rank, p.feePct ?? 0, p.feePct === null ? 1 : 0, p.emailIncluded, p.aiIncluded];
/** The hedonic regression: log of the price billed monthly (main), or of the cheapest month (robustness), on the plan's attributes. */
export function hedonic(spec: "monthly" | "lowest", leaveOut?: string): Ols {
  const rows = dataset().plans.filter((p) => (spec === "monthly" ? p.monthUsd !== null : true) && p.vendor !== leaveOut);
  return ols(rows.map((p) => Math.log(spec === "monthly" ? p.monthUsd! : lowestMonthly(p))), rows.map(row), [...REGRESSORS]);
}
/** Leave one vendor out at a time: each coefficient's range, and how many times its sign flips. */
export function fragility(): { name: string; min: number; max: number; flips: number }[] {
  const full = hedonic("monthly");
  const vendors = [...new Set(dataset().plans.filter((p) => p.monthUsd !== null).map((p) => p.vendor))];
  const fits = vendors.map((v) => hedonic("monthly", v));
  return full.names.map((name, i) => ({
    name, min: Math.min(...fits.map((f) => f.beta[i])), max: Math.max(...fits.map((f) => f.beta[i])),
    flips: fits.filter((f) => Math.sign(f.beta[i]) !== Math.sign(full.beta[i])).length,
  }));
}
/** What the main regression predicts a plan with Marktmorgen's attributes is priced at, and its 95% range (the fit's own, not a forecast). */
export function predictedFor(tier: Tier): { usd: number } {
  const f = hedonic("monthly");
  const rank = TIERS.indexOf(tier) + 1;
  const x = [1, rank, 0, 0, monthlyEmails(tier) > 0 ? 1 : 0, tier === "creator" ? 0 : 1];
  return { usd: Math.exp(x.reduce((s, v, j) => s + v * f.beta[j], 0)) };
}

export function ladders(): { steps: number[]; annual: { vendor: string; plan: string; discount: number; monthsFree: number }[] } {
  const plans = dataset().plans;
  const steps: number[] = [];
  for (const v of new Set(plans.map((p) => p.vendor))) {
    const ps = plans.filter((p) => p.vendor === v).sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < ps.length; i += 1) steps.push(lowestMonthly(ps[i]) / lowestMonthly(ps[i - 1]));
  }
  const annual = plans.filter((p) => p.monthUsd !== null && (p.yearUsd !== null || p.yearMonthlyEqUsd !== null)).map((p) => {
    const year = p.yearUsd ?? p.yearMonthlyEqUsd! * 12;
    return { vendor: p.vendor, plan: p.plan, discount: 1 - year / (12 * p.monthUsd!), monthsFree: 12 - year / p.monthUsd! };
  });
  return { steps, annual };
}

// ------------------------------------------------------------- the margin model, through the repository's code

const PLAN_ROOM: Record<Cycle, number> = { month: 25, year: 100 };
const months = (c: Cycle) => (c === "year" ? 12 : 1);
export type Shares = Record<Printed, number>;
export const ones = (): Shares => Object.fromEntries(ORDER.map((id) => [id, 1])) as Shares;
const zeros = (): Shares => Object.fromEntries(ORDER.map((id) => [id, 0])) as Shares;
/** A plan's usage at full use under shares of each #553 figure, plus list emails given to Store (which carries none at #553), at the registry's PER_EMAIL. */
export function usageFor(tier: Tier, cycle: Cycle, shares: Shares, storeEmails = 0): number {
  return usageCents(tier, cycle, shares) + Math.ceil(storeEmails * PER_EMAIL * months(cycle) * 100);
}
export const priceOf = (cycle: Cycle, monthCents: number) => (cycle === "year" ? monthCents * 10 : monthCents);
const memo = new Map<string, UnitResult>();
export function unitAt(tier: Tier, cycle: Cycle, monthCents: number, shares: Shares, storeEmails = 0, reading = SIZING_READING): UnitResult {
  const key = `${tier}|${cycle}|${monthCents}|${ORDER.map((id) => shares[id]).join(",")}|${storeEmails}|${reading.id}`;
  let u = memo.get(key);
  if (!u) { u = unitUnder(priceOf(cycle, monthCents), usageFor(tier, cycle, shares, storeEmails), reading, true); memo.set(key, u); }
  return u;
}
/** Both intervals keep 60% at full use with the spend floor test's room (25¢ a month, $1 a year). */
export function keeps(tier: Tier, monthCents: number, shares: Shares, storeEmails = 0): boolean {
  return (["month", "year"] as const).every((c) => { const u = unitAt(tier, c, monthCents, shares, storeEmails); return u.meetsFloor && u.usageRoomCents - u.usageCents >= PLAN_ROOM[c]; });
}
/** Printed figures for shares: a share below one rounded down as a page prints it (tidy), one kept. */
export function printedShares(tier: Tier, shares: Shares): Shares {
  const today = figures(tier);
  return Object.fromEntries(ORDER.map((id) => {
    const i = today[id].findIndex((n) => n > 0);
    if (i < 0 || shares[id] >= 1) return [id, i < 0 ? 1 : shares[id]];
    return [id, tidy(id, today[id][i] * shares[id]) / today[id][i]];
  })) as Shares;
}

/** The monthly prices looked at: every $X9 from $9 to twice today's price. */
export function grid(tier: Tier): number[] {
  const out: number[] = [];
  for (let c = 900; c <= 2 * PLAN_PRICES[tier].month; c += 1000) out.push(c);
  return out;
}
export const ELASTICITIES = [-0.5, -1, -1.5, -2] as const;
export const demand = (tier: Tier, monthCents: number, e: number) => (monthCents / anchorCents(tier)) ** e;
/** The profit index: demand at the price times the monthly payment's net at full use, in dollars per customer the band's median price would bring. */
export const profit = (tier: Tier, monthCents: number, shares: Shares, e: number) => (demand(tier, monthCents, e) * unitAt(tier, "month", monthCents, shares).netCents) / 100;

/** The lower share of each #553 figure an alternative allows: A keeps every one; C allows cuts down to a tenth (the proposal's MIN_INCLUDED_SHARE). */
export const ALTERNATIVES = { A: 1, C: 0.1 } as const;
export type Alternative = keyof typeof ALTERNATIVES;
// Reserve exceeds the measured four-cent rounding gap; it reduces both solver budgets.
export const SAFETY_CENTS = 5;

export type MilpInput = {
  generatedBy: string;
  tiers: Tier[];
  printed: Printed[];
  elasticities: number[];
  alternatives: Record<Alternative, number>;
  taxKeptBps: number;
  plans: Record<Tier, {
    anchorCents: number;
    figures: Record<Printed, number>;
    options: { monthCents: number; roomMonth: number; roomYear: number; netAtOnes: number; usageMonthAtOnes: number; exactKeepsAtOnes: boolean; demand: Record<string, number> }[];
    baseMonth: number; baseYear: number; coefMonth: Record<Printed, number>; coefYear: Record<Printed, number>;
  }>;
};
const firstFigure = (tier: Tier, id: Printed) => figures(tier)[id].find((n) => n > 0) ?? 0;
/** The program's coefficients, each read from the repository's code: rooms from unitUnder, usage from usageCents. */
export function milpInput(): MilpInput {
  const plans = {} as MilpInput["plans"];
  for (const tier of TIERS) {
    const base = (c: Cycle) => usageFor(tier, c, zeros());
    const coef = (c: Cycle) => Object.fromEntries(ORDER.map((id) => [id, usageFor(tier, c, { ...zeros(), [id]: 1 }) - base(c)])) as Record<Printed, number>;
    plans[tier] = {
      anchorCents: anchorCents(tier),
      figures: Object.fromEntries(ORDER.map((id) => [id, firstFigure(tier, id)])) as Record<Printed, number>,
      options: grid(tier).map((monthCents) => ({
        monthCents,
        roomMonth: unitUnder(monthCents, 0, SIZING_READING, true).usageRoomCents - PLAN_ROOM.month - SAFETY_CENTS,
        roomYear: unitUnder(monthCents * 10, 0, SIZING_READING, true).usageRoomCents - PLAN_ROOM.year - SAFETY_CENTS,
        netAtOnes: unitAt(tier, "month", monthCents, ones()).netCents,
        usageMonthAtOnes: usageFor(tier, "month", ones()),
        exactKeepsAtOnes: keeps(tier, monthCents, ones()),
        // Twelve significant digits: Math.pow may differ in its last bit between Node versions.
        demand: Object.fromEntries(ELASTICITIES.map((e) => [String(e), Number(demand(tier, monthCents, e).toPrecision(12))])),
      })),
      baseMonth: base("month"), baseYear: base("year"), coefMonth: coef("month"), coefYear: coef("year"),
    };
  }
  return { generatedBy: "tests/pricing-optimization-table.ts milpInput()", tiers: [...TIERS], printed: [...ORDER], elasticities: [...ELASTICITIES], alternatives: { ...ALTERNATIVES }, taxKeptBps: 10_000 - SIZING_READING.profitTaxBps, plans };
}
/** How far the program's linear usage is from usageCents at today's figures, in cents (rounding only). */
export function linearityGap(): number {
  const input = milpInput();
  let worst = 0;
  for (const tier of TIERS) for (const c of ["month", "year"] as const) {
    const p = input.plans[tier];
    const lin = (c === "month" ? p.baseMonth : p.baseYear) + ORDER.reduce((s, id) => s + (c === "month" ? p.coefMonth : p.coefYear)[id], 0);
    worst = Math.max(worst, Math.abs(lin - usageFor(tier, c, ones())));
  }
  return worst;
}

export type MilpSolution = { scenario: string; alternative: Alternative; status: string; objective: number; plans: Record<Tier, { monthCents: number; shares: Shares }> };
export type MilpOutput = { solver: string; solutions: MilpSolution[] };
export const milpOutput = (): MilpOutput => readJson<MilpOutput>(OUTPUT_FILE);

let exhaustiveInput: MilpInput | null = null;
/** Enumerate the same raw-share problem as the solver; printed rounding is
 * checked only after selection, never used to loosen its five-cent reserve. */
export function exhaustive(tier: Tier, alt: Alternative, e: number): { monthCents: number; shares: Shares; profit: number } | null {
  const input = exhaustiveInput ??= milpInput();
  const plan = input.plans[tier];
  const lowest = Object.fromEntries(ORDER.map(id => [id, plan.figures[id] > 0 ? ALTERNATIVES[alt] : 1])) as Shares;
  const used = (cycle: "Month" | "Year") => (cycle === "Month" ? plan.baseMonth : plan.baseYear) +
    ORDER.reduce((sum, id) => sum + (cycle === "Month" ? plan.coefMonth : plan.coefYear)[id] * lowest[id], 0);
  let best: { monthCents: number; shares: Shares; profit: number } | null = null;
  for (const option of plan.options) {
    const monthCents = option.monthCents;
    if (alt === "A" ? !option.exactKeepsAtOnes : used("Month") > option.roomMonth || used("Year") > option.roomYear) continue;
    const net = alt === "A" ? option.netAtOnes : option.netAtOnes + input.taxKeptBps / 10_000 *
      ORDER.reduce((sum, id) => sum + plan.coefMonth[id] * (1 - lowest[id]), 0);
    const pr = option.demand[String(e)] * net / 100;
    if (!best || pr > best.profit) best = { monthCents, shares: lowest, profit: pr };
  }
  return best;
}
/** One figure cut to a tenth of #553's, every other kept: the lowest price that keeps 60%, and the profit index over A's best per scenario. */
export function eachCut(tier: Tier): { id: Printed; figure: string; monthCents: number; ratio: Record<string, number> }[] {
  return ORDER.filter((id) => firstFigure(tier, id) > 0).map((id) => {
    const shares = printedShares(tier, { ...ones(), [id]: ALTERNATIVES.C });
    const monthCents = grid(tier).find((m) => keeps(tier, m, shares))!;
    const ratio = Object.fromEntries(ELASTICITIES.map((e) => [String(e), profit(tier, monthCents, shares, e) / exhaustive(tier, "A", e)!.profit]));
    const n = firstFigure(tier, id) * shares[id];
    return { id, figure: id === "storage" ? `${num(n / GB)} GB` : num(Math.round(n)), monthCents, ratio };
  });
}

/** A program's solution as a page would print it, checked by the repository's code. */
export function verified(sol: MilpSolution): { tier: Tier; monthCents: number; shares: Shares; keeps: boolean; month: UnitResult; year: UnitResult; profit: number }[] {
  const e = Number(sol.scenario);
  return TIERS.map((tier) => {
    const s = printedShares(tier, sol.plans[tier].shares);
    const m = sol.plans[tier].monthCents;
    return { tier, monthCents: m, shares: s, keeps: keeps(tier, m, s), month: unitAt(tier, "month", m, s), year: unitAt(tier, "year", m, s), profit: profit(tier, m, s, e) };
  });
}

/** Minimax regret over alternative A's feasible prices: the price whose largest shortfall from each scenario's best, as a share of that best, is smallest. */
export function minimaxRegret(tier: Tier): { monthCents: number; regret: number; byScenario: Record<string, number> } {
  const feasible = grid(tier).filter((m) => keeps(tier, m, ones()));
  const best = Object.fromEntries(ELASTICITIES.map((e) => [e, Math.max(...feasible.map((m) => profit(tier, m, ones(), e)))]));
  let choice = { monthCents: feasible[0], regret: Infinity, byScenario: {} as Record<string, number> };
  for (const m of feasible) {
    const byScenario = Object.fromEntries(ELASTICITIES.map((e) => [String(e), 1 - profit(tier, m, ones(), e) / best[e]]));
    const regret = Math.max(...Object.values(byScenario));
    if (regret < choice.regret - 1e-12) choice = { monthCents: m, regret, byScenario };
  }
  return choice;
}

/** A price's worst relative shortfall from each scenario's best, among alternative A's feasible prices. */
export function regretAt(tier: Tier, monthCents: number): number {
  const feasible = grid(tier).filter((m) => keeps(tier, m, ones()));
  return Math.max(...ELASTICITIES.map((e) => 1 - profit(tier, monthCents, ones(), e) / Math.max(...feasible.map((m) => profit(tier, m, ones(), e)))));
}
/** The lowest price on the grid that keeps 60% at every #553 figure. */
export const lowestA = (tier: Tier) => grid(tier).find((m) => keeps(tier, m, ones()))!;

/** Customers needed per $100 a month of company fixed cost, at a plan's price and full use (lib/customer-base-rules.ts). */
export function basePerHundred(tier: Tier, monthCents: number, shares = ones()): number | null {
  const unit = (c: Cycle) => {
    const u = unitAt(tier, c, monthCents, shares);
    return {
      months: (c === "year" ? 12 : 1) as 1 | 12,
      scenario: {
        collectedRevenueCents: u.revenueCents, refundableRevenueCents: 0, taxesCeilingCents: u.taxCents,
        costCeilings: { infrastructure: u.usageCents, storageDeliveryVideo: 0, email: 0, ai: 0, paymentAndFx: u.feeCents + u.remittanceCents, supportAndOperations: 0, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 0, refundAndDisputeFees: u.refundReserveCents + u.disputeReserveCents, other: 0 },
        allCostsBounded: true, allTaxesReviewed: true, revenueCollected: true,
      },
    };
  };
  const r = assessMinimumCustomerBase([unit("month"), unit("year")], {
    monthlyFixedCostsCeilingCents: 10_000, monthlyFixedTaxesCeilingCents: 0, allFixedCostsBounded: true, allFixedTaxesReviewed: true,
    fixedCostsEvidence: "hypothetical: $100 a month, to scale the count; not a reviewed budget", fixedTaxEvidence: "hypothetical: none", reviewedPayingCustomers: 0,
  });
  return r.status === "calculated" ? r.minimumCustomers : null;
}

// ------------------------------------------------------------- superiority in the band (alternative B)

/** Hours watched a month that a competitor's video bandwidth in GB buys at the heaviest viewing the registry prices. */
const hoursForGB = (gb: number) => (gb * 1e9) / (viewingBytes(3600, TOP_HEIGHT, Number.POSITIVE_INFINITY) * FETCHED_AHEAD);
export type Attribute = "list-email" | "storage" | "video" | "contacts" | "seats" | "products" | "fee";
export type Comparison = { attribute: Attribute; ours: string; best: string; bestFrom: string; unlimitedIn: string[]; meets: boolean; priced: boolean; target: number | null };
const numeric = (v: Limit): number | null => (typeof v === "number" ? v : null);
export function comparisons(tier: Tier): Comparison[] {
  const plans = band(tier);
  const fin = (get: (p: CompetitorPlan) => Limit) => {
    const ps = plans.filter((p) => numeric(get(p)) !== null);
    const best = ps.reduce<CompetitorPlan | null>((b, p) => (!b || numeric(get(p))! > numeric(get(b))! ? p : b), null);
    return { best, value: best ? numeric(get(best))! : null, unlimited: plans.filter((p) => get(p) === "unlimited").map((p) => `${p.vendor} ${p.plan}`) };
  };
  const out: Comparison[] = [];
  const add = (attribute: Attribute, ours: number, get: (p: CompetitorPlan) => Limit, unitName: string, priced: boolean, convert = (n: number) => n) => {
    const f = fin(get);
    const target = f.value === null ? null : Math.ceil(convert(f.value));
    out.push({
      attribute, ours: `${ours.toLocaleString("en-US")} ${unitName}`,
      best: f.value === null ? "none stated" : `${f.value.toLocaleString("en-US")}${attribute === "video" ? " GB of bandwidth" : ""}`,
      bestFrom: f.best ? `${f.best.vendor} ${f.best.plan}` : "—", unlimitedIn: f.unlimited,
      meets: f.unlimited.length === 0 && (target === null || ours >= target), priced, target,
    });
  };
  add("list-email", monthlyEmails(tier), (p) => p.emailsMonth, "list emails a month", true);
  add("storage", PAID_STORAGE_BYTES[tier] / GB, (p) => p.storageGB, "GB", true);
  add("video", PAID_VIDEO_HOURS[tier], (p) => p.videoBandwidthGB, "hours watched a month", true, hoursForGB);
  add("contacts", MAX_LEADS, (p) => p.contacts, "contacts", false);
  add("seats", MAX_TEAM, (p) => p.seats, "team members", false);
  add("products", MAX_PRODUCTS, (p) => p.products, "products", false);
  const fees = plans.filter((p) => p.feePct !== null).map((p) => p.feePct!);
  out.push({ attribute: "fee", ours: "0% of a sale", best: `${Math.min(...fees)}%`, bestFrom: plans.filter((p) => p.feePct === Math.min(...fees)).map((p) => `${p.vendor} ${p.plan}`).join(", "), unlimitedIn: [], meets: true, priced: false, target: 0 });
  return out;
}
/** The lowest $X9 price at which the plan keeps 60% with its metered attributes raised to the band's largest finite figure (each alone, and all together). */
export function superiorityPrice(tier: Tier, which: Attribute[]): { monthCents: number; shares: Shares; storeEmails: number } | null {
  const shares = ones();
  let storeEmails = 0;
  for (const c of comparisons(tier)) {
    if (!which.includes(c.attribute) || !c.priced || c.target === null) continue;
    if (c.attribute === "list-email") { if (monthlyEmails(tier) === 0) storeEmails = c.target; else shares["list-email"] = Math.max(1, c.target / monthlyEmails(tier)); }
    if (c.attribute === "storage") shares.storage = Math.max(1, c.target / (PAID_STORAGE_BYTES[tier] / GB));
    if (c.attribute === "video") shares.video = Math.max(1, c.target / PAID_VIDEO_HOURS[tier]);
  }
  // Double until it keeps, then walk up from half that in $10 steps: the lowest $X9 price that keeps.
  let hi = PLAN_PRICES[tier].month - 100;
  while (!keeps(tier, hi, shares, storeEmails)) { hi = hi * 2 + 900; if (hi > 1e9) return null; }
  for (let m = Math.max(900, Math.floor(hi / 2000) * 1000 - 100); m <= hi; m += 1000) if (keeps(tier, m, shares, storeEmails)) return { monthCents: m, shares, storeEmails };
  return { monthCents: hi, shares, storeEmails };
}

// ------------------------------------------------------------- zero-cost features

type FeatureRow = { section: string; feature: string; mark: string };
export function zeroCostRows(): FeatureRow[] {
  const text = readFileSync(join(root(), "docs/zero-cost-value-2026-10-18.md"), "utf8");
  const rows: FeatureRow[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const m = /^\| ([^|]+) \| ([^|]+) \|/.exec(line);
    if (m && m[1].trim() !== "Feature" && !m[1].startsWith("---") && /\([abcd]\)/.test(m[2])) rows.push({ section, feature: m[1].trim(), mark: m[2].trim() });
  }
  return rows;
}
/** What Stan sells only on Creator Pro ($99), as its help article lists it, and the row of docs/zero-cost-value-2026-10-18.md that says whether Marktmorgen has it. */
export const STAN_PRO_ONLY = [
  "Discount codes, with a limit on uses", "Limited-quantity offers", "Upsells and order bumps", "Payment plans, Afterpay and Klarna", "Funnels",
  "Affiliate management, customers as affiliates", "Contact import", "Email broadcasts and flows", "Meta, Google, Pinterest and TikTok pixels",
];

// ------------------------------------------------------------- the document

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const usd2 = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const f3 = (n: number) => n.toFixed(3);
const num = (n: number) => n.toLocaleString("en-US");
const showShares = (tier: Tier, s: Shares) => ORDER.filter((id) => firstFigure(tier, id) > 0 && s[id] < 1).map((id) => `${id} ${num(Math.round(firstFigure(tier, id) * s[id] * (id === "storage" ? 1 / GB : 1)))}${id === "storage" ? " GB" : ""}`).join(", ") || "every #553 figure";

export function renderPricingOptimization(): string {
  const d = dataset();
  const out: string[] = [];
  const push = (...l: string[]) => out.push(...l);
  const solutions = milpOutput();
  const src = (id: string) => d.sources.find((s) => s.id === id)!;

  push("# Prices and limits that maximize profit, under stated demand scenarios: 18 October 2026");
  push("");
  push("<!-- Generated by `node scripts/pricing-optimization.mjs` from docs/pricing-optimization-data-2026-10-18.json and tests/pricing-optimization-table.ts (the solver is scripts/pricing-optimization-milp.py). Do not edit by hand: tests/pricing-optimization.test.ts fails when this file, the program's input or its output is stale. -->");
  push("");
  push("**An analysis for the owner, not a change.** No price, limit, gate or tax assumption in code changes with it, and `PLANS_ON_SALE` stays false. Every margin is the repository's own (lib/receiving-costs.ts `unitUnder` under the sizing reading; tests/limits-proposal-table.ts `usageCents`; lib/customer-base-rules.ts `assessMinimumCustomerBase`); every competitor figure is in the dataset with its page and the day it was read. **Demand is unknown**: every profit below is under a labeled constant-elasticity scenario, not a forecast.");
  push("");

  // ---------------- recommendation first
  push("## The recommendation, per plan");
  push("");
  push("| Plan | Monthly / yearly price | Included limits | Net at full use, monthly / yearly | Net under the most-tax reading (the gate) | Customers needed per $100 a month of fixed cost | Today (#553) |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const tier of TIERS) {
    const r = minimaxRegret(tier);
    const m = unitAt(tier, "month", r.monthCents, ones()), y = unitAt(tier, "year", r.monthCents, ones());
    push(`| ${PLAN_TITLES[tier]} | **${usd(r.monthCents)} / ${usd(r.monthCents * 10)}** | every #553 figure, none cut | ${pctOf(m.netBps)} / ${pctOf(y.netBps)} | ${pctOf(unitAt(tier, "month", r.monthCents, ones(), 0, MOST_TAX_READING).netBps)} | ${basePerHundred(tier, r.monthCents) ?? "none finite"} | ${usd(PLAN_PRICES[tier].month)} / ${usd(PLAN_PRICES[tier].year)} |`);
  }
  push("");
  const credits = CREDIT_AMOUNTS.map((a) => creditOption(a));
  push(`**Usage above the included figures: prepaid credits** (docs/pack-cost-decomposition-2026-10-18.md, option 3), sold at ${credits.map((c) => usd(c.amountCents)).join(", ")}, each keeping 60% however it is spent (${credits.map((c) => pctOf(c.worst.netBps)).join(", ")} on its dearest-to-serve resource), at the rates of that document's table (list email ${credits.map((c) => usd2(c.rates.find((r) => r.pack.id === "list-email")!.centsPerDisplay)).join(", ")} per 1,000).`);
  push("");
  push("| Plan | Today's price: worst regret across the four scenarios | Today's price over the band's median | Today's price over the regression's prediction |");
  push("| --- | --- | --- | --- |");
  for (const tier of TIERS) push(`| ${PLAN_TITLES[tier]} | ${(regretAt(tier, PLAN_PRICES[tier].month) * 100).toFixed(1)}% | ${(PLAN_PRICES[tier].month / anchorCents(tier)).toFixed(2)}× | ${(PLAN_PRICES[tier].month / Math.round(predictedFor(tier).usd * 100)).toFixed(2)}× |`);
  push("");
  push(`The minimax-regret price hedges between scenarios in which demand barely falls with price (where higher is better without end) and scenarios in which it falls fast (where the lowest price that keeps 60%, about today's, is best). **If the owner reads the competitor evidence above (today's prices are already well above the band medians and above what the regression predicts for plans with these attributes) as a sign that demand is elastic, the scenario-best prices are instead the lowest that keep 60% with every #553 figure (${TIERS.map((t) => `${PLAN_TITLES[t]} ${usd(lowestA(t))}`).join(", ")})**, and the table above says how much regret today's prices carry. No data decides between them yet.`);
  push("");
  push("How each figure was chosen: the price is the **minimax-regret** price over the four demand scenarios among the prices that keep 60% at full use of every #553 figure (alternative A below, the owner's rule \"não remover limites visíveis\"); the limits are #553's, because no scenario here gives demand a reason to value a cut, and cutting is the owner's decision (alternative C prices it); credits are the decomposition's best structural option. **None of it is in force.**");
  push("");

  // ---------------- dataset
  push("## 1. The competitors, as read");
  push("");
  push(`${d.plans.length} paid plans of ${new Set(d.plans.map((p) => p.vendor)).size} vendors, read on ${d.readOn}. ${d.note}`);
  push("");
  push("| Vendor | Plan | Monthly | Yearly | Fee on a sale | List emails a month | Contacts | Storage GB | Seats | Products | AI listed | Source |");
  push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const lim = (v: Limit) => (v === null ? "—" : typeof v === "number" ? num(v) : v);
  for (const p of d.plans) {
    const year = p.yearUsd !== null ? `$${num(p.yearUsd)}` : p.yearMonthlyEqUsd !== null ? `$${p.yearMonthlyEqUsd}/mo billed yearly` : "—";
    push(`| ${p.vendor} | ${p.plan}${p.caveat ? ` (${p.caveat})` : ""} | ${p.monthUsd === null ? "—" : `$${p.monthUsd}`} | ${year} | ${p.feePct === null ? "not stated" : `${p.feePct}%${p.feeIncludesProcessing ? " (incl. processing)" : ""}`} | ${lim(p.emailsMonth)} | ${lim(p.contacts)} | ${lim(p.storageGB)} | ${lim(p.seats)} | ${lim(p.products)} | ${p.aiIncluded ? "yes" : "—"} | ${p.sources.map((id) => `[${id}](${src(id).url})`).join(" ")} |`);
  }
  push("");
  for (const f of d.feeOnly) push(`- **${f.vendor}** (no subscription): ${f.what} ([${f.source}](${src(f.source).url})).`);
  push("- **Linktree and Shopify**: their pages did not state a price that could be read (see sources); no figure of theirs is used.");
  push("");
  push("**Sources**");
  push("");
  push("| Id | Page | Read | Type |");
  push("| --- | --- | --- | --- |");
  for (const s of d.sources) push(`| ${s.id} | [${s.url}](${s.url}) | ${s.read} | ${s.type} |`);
  push("");
  push("**Size and brand, with the kind of evidence each is**");
  push("");
  push("| Vendor | Evidence | Kind |");
  push("| --- | --- | --- |");
  for (const b of d.brand) push(`| ${b.vendor} | ${b.evidence}${b.source ? ` ([${b.source}](${src(b.source).url}))` : ""} | ${b.sourceType} |`);
  push("");

  // ---------------- statistics
  const main = hedonic("monthly"), robust = hedonic("lowest");
  push("## 2. What the market prices: a hedonic regression");
  push("");
  push(`Ordinary least squares of the log of each plan's price on its attributes, with heteroskedasticity-robust (HC1) standard errors and Student-t 95% intervals. Main: the price billed monthly (n = ${main.n}). Robustness: the cheapest month, yearly billing where offered (n = ${robust.n}, adds the plans with no monthly price).`);
  push("");
  push("| Regressor | Main: coefficient (robust SE) | 95% interval | p | Robustness: coefficient (robust SE) | Leave one vendor out: range | Sign flips |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  const frag = fragility();
  main.names.forEach((name, i) => push(`| ${name} | ${f3(main.beta[i])} (${f3(main.se[i])}) | ${f3(main.ciLow[i])} to ${f3(main.ciHigh[i])} | ${main.p[i].toFixed(3)} | ${f3(robust.beta[i])} (${f3(robust.se[i])}) | ${f3(frag[i].min)} to ${f3(frag[i].max)} | ${frag[i].flips} |`));
  push("");
  push(`R² ${main.r2.toFixed(3)} (adjusted ${main.adjR2.toFixed(3)}), main; ${robust.r2.toFixed(3)} (adjusted ${robust.adjR2.toFixed(3)}), robustness. Each step up a vendor's ladder multiplies the price by about ${Math.exp(main.beta[1]).toFixed(2)} (main).`);
  push("");
  const away = main.names.filter((_, i) => i > 0 && (main.ciLow[i] > 0 || main.ciHigh[i] < 0));
  const near = main.names.filter((_, i) => i > 0 && !(main.ciLow[i] > 0 || main.ciHigh[i] < 0));
  const flipped = frag.filter((f, i) => i > 0 && f.flips > 0).map((f) => f.name);
  push(`**How far to trust it.** Thirty-odd plans of a dozen vendors chosen by this work, observational, attributes coded from what each page lists (a page that does not list email marketing is coded as not having it), fees that sometimes include card processing: an association, not a willingness to pay. The 95% interval excludes zero for ${away.join(" and ")}; it includes zero for ${near.join(", ")}; leaving one vendor out flips the sign of ${flipped.length ? flipped.join(" and ") : "none"}. It is used here as a diagnostic, not as demand.`);
  push("");
  push("| Plan | What the main fit predicts a plan with Marktmorgen's attributes (rank, 0% fee, email and AI as on the plan) is priced at | Today (#553) |");
  push("| --- | --- | --- |");
  for (const tier of TIERS) push(`| ${PLAN_TITLES[tier]} | ${usd2(Math.round(predictedFor(tier).usd * 100))} | ${usd(PLAN_PRICES[tier].month)} |`);
  push("");
  const lad = ladders();
  push(`**Tiers, anchors and the yearly discount.** Vendors sell ${median([...new Set(d.plans.map((p) => p.vendor))].map((v) => d.plans.filter((p) => p.vendor === v).length))} paid plans (median); each step up a ladder is ${median(lad.steps).toFixed(2)}× the one below (median of ${lad.steps.length} steps, cheapest month). Where both prices are stated (${lad.annual.length} plans), the yearly price is ${(median(lad.annual.map((a) => a.discount)) * 100).toFixed(1)}% below twelve monthly payments (median), about ${median(lad.annual.map((a) => a.monthsFree)).toFixed(1)} months free; Marktmorgen's ten monthly payments is ${(100 * (1 - 10 / 12)).toFixed(1)}%, two months free. Marktmorgen's own steps are ${(PLAN_PRICES.pro.month / PLAN_PRICES.creator.month).toFixed(2)}× and ${(PLAN_PRICES.scale.month / PLAN_PRICES.pro.month).toFixed(2)}×.`);
  push("");
  push("| Band | Its competitor plans | Median price a month (the demand anchor) |");
  push("| --- | --- | --- |");
  for (const tier of TIERS) push(`| ${PLAN_TITLES[tier]} (${BANDS[tier].to === Number.POSITIVE_INFINITY ? `$${BANDS[tier].from} and up` : `$${BANDS[tier].from} to under $${BANDS[tier].to}`} a month) | ${band(tier).map((p) => `${p.vendor} ${p.plan}`).join(", ")} | ${usd2(anchorCents(tier))} |`);
  push("");

  // ---------------- the program
  push("## 3. The optimization");
  push("");
  push("**Decisions.** For each plan, its monthly price on the grid of every $X9 from $9 to twice today's (the year at ten monthly payments, Marktmorgen's convention), and the share of each of #553's eight per-use figures (visits, orders, list emails, AI, storage, video hours, access emails, store emails).");
  push("");
  push("**Constraints.** Every plan, alone, at full use of every figure, keeps 60% on both intervals with the spend floor test's room (25¢ a month, $1 a year), under the sizing reading: the program's room per price is `unitUnder`'s, less " + `${SAFETY_CENTS}¢` + " of safety for rounding, and its usage is linear in the shares, with coefficients read from `usageCents` (the largest gap between that line and `usageCents` at today's figures is " + `${linearityGap()}¢` + "). Prices rise from Store to Studio to Scale; no figure of a plan is above the same figure of the plan above it. The number of plans stays three. Then each solution, as a page would print it, is checked again by `unitUnder` itself.");
  push("");
  push("**Objective.** Demand at each price is q = (price ÷ the band's median price)^ε, one scenario for each ε in −0.5, −1, −1.5 and −2; the objective is the sum over plans of q times the monthly payment's net at full use: **a profit index in dollars per customer the band's median price would bring**, comparable within a scenario only. No scenario is a measurement: no sale has ever been open.");
  push("");
  push("**Alternatives.** **A**: no #553 figure is cut (the owner's rule). **C**: each figure may be cut to a tenth of #553's (the proposal's floor), shown apart so the owner sees what a cut is worth under each scenario. **B** (superiority, below) is not a scenario of the program: it is the price at which each plan would be at least the best competitor in its band on every metered figure.");
  push("");
  push(`Solver: ${solutions.solver}.`);
  push("");
  push("| Scenario | Alternative | Store | Studio | Scale | Each plan keeps 60% (checked) | Same as the exhaustive search |");
  push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const sol of solutions.solutions) {
    const v = verified(sol);
    const same = v.every((x) => { const ex = exhaustive(x.tier, sol.alternative, Number(sol.scenario)); return ex !== null && ex.monthCents === x.monthCents; });
    push(`| ε = ${sol.scenario} | ${sol.alternative} | ${v.map((x) => `${usd(x.monthCents)}${sol.alternative === "C" ? ` (${showShares(x.tier, x.shares)})` : ""}`).join(" | ")} | ${v.every((x) => x.keeps) ? "yes" : "**no**"} (${v.map((x) => `${pctOf(x.month.netBps)} / ${pctOf(x.year.netBps)}`).join("; ")}) | ${same ? "yes" : "**no**"} |`);
  }
  push("");
  push(`**What the scenarios agree on, and where they part.** Under A the lowest price that keeps 60% with every #553 figure is ${TIERS.map((t) => `${PLAN_TITLES[t]} ${usd(lowestA(t))}`).join(", ")} (today ${TIERS.map((t) => usd(PLAN_PRICES[t].month)).join(", ")}): nothing near the band medians is possible without cutting figures. With |ε| at most 1 (−0.5, −1), constant-elasticity demand has no finite best price, and the program goes to the top of the grid: that is the model's shape, not a finding that the market would pay it. With |ε| above 1 (−1.5, −2) the best price is that lowest one. So the scenarios disagree on direction and agree only on the floor.`);
  push("");
  push("**Usage above the included figures, and its billing structure.** Not in the program, because the demand for usage is not known even in scenario form. docs/pack-cost-decomposition-2026-10-18.md chose the structure (prepaid credits: no non-payment exposure, fixed cents spread over larger amounts) and priced each rate at the lowest that keeps 60%; under the same logic as above, that floor is the best price when demand for usage falls fast with its price (|ε| above 1), and no finite best exists otherwise.");
  push("");
  push("**Minimax regret** (alternative A): for each price that keeps 60%, its largest shortfall from each scenario's best, as a share of that best; the price with the smallest is the recommendation.");
  push("");
  push("| Plan | Price | Worst regret | Regret at ε −0.5 / −1 / −1.5 / −2 | Customers needed per $100 a month of fixed cost |");
  push("| --- | --- | --- | --- | --- |");
  for (const tier of TIERS) {
    const r = minimaxRegret(tier);
    push(`| ${PLAN_TITLES[tier]} | ${usd(r.monthCents)} | ${(r.regret * 100).toFixed(1)}% | ${ELASTICITIES.map((e) => `${(r.byScenario[String(e)] * 100).toFixed(1)}%`).join(" / ")} | ${basePerHundred(tier, r.monthCents) ?? "none finite"} |`);
  }
  push("");
  push("**The minimum paying base at each price.** Company fixed costs are not reviewed for Marktmorgen (lib/customer-base-rules.ts needs them; the review is null), so the base is given per $100 a month of fixed cost, from that file's own rule (the worst of the monthly and the yearly unit): multiply by the real monthly figure once it is reviewed.");
  push("");
  push("| Plan | " + [1, 1.25, 1.5, 2].map((k) => `${k}× today's price`).join(" | ") + " |");
  push("| --- | " + [1, 1.25, 1.5, 2].map(() => "---").join(" | ") + " |");
  for (const tier of TIERS) push(`| ${PLAN_TITLES[tier]} | ` + [1, 1.25, 1.5, 2].map((k) => { const m = Math.floor((PLAN_PRICES[tier].month * k) / 1000) * 1000 - 100; const mm = Math.max(m, PLAN_PRICES[tier].month); return `${usd(mm)}: ${basePerHundred(tier, mm) ?? "none finite"}`; }).join(" | ") + " |");
  push("");
  push("**Alternative C, what a cut is worth.** The profit index at C's best price over A's best, per scenario. It is an **upper bound**: the demand model cannot see the value a cut takes away, so it always prefers the cut.");
  push("");
  push("| Plan | " + ELASTICITIES.map((e) => `ε ${e}: C over A`).join(" | ") + " |");
  push("| --- | " + ELASTICITIES.map(() => "---").join(" | ") + " |");
  for (const tier of TIERS) push(`| ${PLAN_TITLES[tier]} | ` + ELASTICITIES.map((e) => { const a = exhaustive(tier, "A", e)!, c = exhaustive(tier, "C", e)!; return `${(c.profit / a.profit).toFixed(2)}× (${usd(c.monthCents)} against ${usd(a.monthCents)})`; }).join(" | ") + " |");
  push("");

  push("**Each cut alone.** The same, one figure at a time cut to a tenth of #553's (rounded down as a page prints it), every other kept: the lowest price that keeps 60%, and the profit index over A's best in the two scenarios where a cut can lower the price.");
  push("");
  push("| Plan | Figure cut to a tenth | Its figure after the cut | Lowest price that keeps 60% | ε −1.5: over A | ε −2: over A |");
  push("| --- | --- | --- | --- | --- | --- |");
  for (const tier of TIERS) for (const c of eachCut(tier)) push(`| ${PLAN_TITLES[tier]} | ${c.id} | ${c.figure} | ${usd(c.monthCents)} | ${c.ratio["-1.5"].toFixed(2)}× | ${c.ratio["-2"].toFixed(2)}× |`);
  push("");

  // ---------------- superiority
  push("## 4. At least the best competitor in the band, on every attribute (alternative B)");
  push("");
  push("For each plan, each attribute Marktmorgen and its band's competitors both state, against the best competitor in the band (the largest finite figure; \"unlimited\" on a page is a figure no finite limit can equal). A video bandwidth in GB is turned into hours watched at the heaviest viewing the registry prices (1080p, fetched ahead). AI is not compared: the units (credits, words, writing jobs) do not convert.");
  push("");
  for (const tier of TIERS) {
    push(`**${PLAN_TITLES[tier]}**`);
    push("");
    push("| Attribute | Marktmorgen | Best finite in the band | From | Unlimited in the band | At least as good |");
    push("| --- | --- | --- | --- | --- | --- |");
    for (const c of comparisons(tier)) push(`| ${c.attribute} | ${c.ours} | ${c.best}${c.attribute === "video" && c.target !== null ? ` (${num(c.target)} hours)` : ""} | ${c.bestFrom} | ${c.unlimitedIn.join(", ") || "—"} | ${c.meets ? "yes" : "**no**"} |`);
    push("");
    const priced = comparisons(tier).filter((c) => c.priced && c.target !== null);
    const each = priced.map((c) => ({ c, s: superiorityPrice(tier, [c.attribute]) }));
    const all = superiorityPrice(tier, priced.map((c) => c.attribute));
    push(`${tier === "creator" ? "Store carries no list email at #553 and lib/plan.ts gates broadcasts to Studio (`canUse`), so its list-email line also needs that gate opened. " : ""}Raised to the band's best finite figure, the lowest price that keeps 60%: ${each.map(({ c, s }) => `${c.attribute} ${s ? usd(s.monthCents) : "none"}`).join("; ")}; all of them together ${all ? `**${usd(all.monthCents)} a month**` : "none"} (today ${usd(PLAN_PRICES[tier].month)}). ${comparisons(tier).some((c) => c.unlimitedIn.length) ? `Where a competitor in the band prints \"unlimited\" (${[...new Set(comparisons(tier).filter((c) => c.unlimitedIn.length).map((c) => c.attribute))].join(", ")}), superiority is infeasible at any price under the 60% rule: an unlimited allowance cannot be held to 60% at full use.` : ""}`);
    push("");
  }
  push("So \"superior on every attribute to the best competitor in its band\" is **infeasible** for every plan (an unlimited figure in every band), and on the finite metered figures alone it costs the prices above, far above both the band and the scenarios' best prices. Where Marktmorgen is ahead without it: 0% of a sale (tied with the best in each band), 2,000 products, 100,000 contacts (above every finite figure in the Store and Studio bands).");
  push("");

  // ---------------- zero-cost features
  push("## 5. Features with no marginal cost that competitors charge for");
  push("");
  const rows = zeroCostRows();
  const stan = rows.filter((r) => r.section.startsWith("Stan"));
  push("Stan sells these only on Creator Pro ($99 a month against Creator's $29; [stan-help](" + src("stan-help").url + ")). Whether Marktmorgen has each is docs/zero-cost-value-2026-10-18.md's mark ((a) built, with its file there):");
  push("");
  push("| Stan Creator Pro only | Marktmorgen |");
  push("| --- | --- |");
  for (const name of STAN_PRO_ONLY) {
    const r = stan.find((x) => x.feature === name);
    if (!r) throw new Error(`docs/zero-cost-value-2026-10-18.md no longer lists "${name}" under Stan`);
    push(`| ${name} | ${r.mark}${name === "Email broadcasts and flows" ? `; Store carries ${monthlyEmails("creator")} list emails a month, so broadcasts need Studio` : ""} |`);
  }
  push("");
  const byMark = (m: string) => rows.filter((r) => r.mark.startsWith(m)).length;
  push(`Across the six competitors that document reads, ${byMark("(a)")} named features are marked (a), built (in full or in part); ${byMark("(b)")} (b), zero or near-zero marginal cost and not built: ${rows.filter((r) => r.mark.startsWith("(b)")).map((r) => r.feature).join("; ")}.`);
  push("");
  push("Two zero-per-use features that Marktmorgen gates to Studio (lib/plan.ts `canUse`, `hasPro`) and a competitor sells low: a custom domain (Beacons Creator, $10, \"free first year\") and removing Marktmorgen's name from the page (Beacons Creator Plus, $30, \"logo removal\"). lib/plan.ts says the name stays on Store on purpose (it brings the next creator); a custom domain is not a line of tests/plan-cost-registry.ts, so opening it on Store needs that line first. Neither is changed here.");
  push("");

  // ---------------- what is not known
  push("## What is not known");
  push("");
  push("- **Demand.** No sale has been open, so no elasticity, conversion rate or willingness to pay has been measured. The four scenarios are assumptions, anchored on the band's median price; the minimax-regret price is the choice that is least wrong across them, not the best one under the truth.");
  push("- **The value of a limit.** The demand model takes price only. It cannot say how many buyers a cut figure or an \"unlimited\" competitor costs, which is why alternative C always looks better and is shown apart.");
  push("- **Use.** Every margin is at full use of every figure, the owner's rule; real use will be lower and margins higher.");
  push("- **The regression.** A small, chosen, observational sample; attributes coded from what each page lists; fees that sometimes include processing. It is a diagnostic.");
  push("- **Pages not read.** Linktree's and Shopify's prices did not render or were not stated; Stripe's pricing page refused the fetch (docs/pack-cost-decomposition-2026-10-18.md). Gumroad and Whop sell with no subscription, so they are not in the bands.");
  push("- **Fixed costs.** Not reviewed for Marktmorgen; the base is per $100 a month.");
  push("- **The gate.** Under the most-tax reading no plan keeps 60% at any price here (the recommendation table), so nothing opens.");
  push("");
  return HISTORICAL_MARGIN_NOTICE + out.join("\n");
}
