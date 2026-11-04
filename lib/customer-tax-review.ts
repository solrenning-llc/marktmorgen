import { mostCorrectTaxesOf } from './receiving-costs';

/** A reviewed ceiling, not proof of legal facts or permission to sell. No real
 * review is supplied here. Legacy callers retain their historical protection. */
export const CUSTOMER_TAX_REVIEW_POLICY = Object.freeze({
  schema: 1, id: 'TX-2026-10-27', basis: 'isolated-full-rights-worst-case',
  unknown: 'deny', requirement: 'explicit-TX-evidence-required-no-legacy-profit-approval', currency: 'USD', accountingCurrency: 'BRL',
  allocation: 'whole-scoped-calendar-books-no-tax-credit-for-extra-cost-room',
  contractAdmission: 'explicit-review-snapshot-admission-and-liability-coverage',
  fundedExposure: 'legacy-only-no-TX-migration-in-this-unit',
  maxBooks: 2, maxContractBooks: 12, maxExchangesPerBook: 1200,
} as const);
export type TaxEvidence = { date: string; source: string; facts: string };
export type ContractTaxCoverage = {
  reviewId: string; termsSnapshot: string;
  admissionsFrom: string; admissionsUntil: string; liabilitiesThrough: string;
  evidence: TaxEvidence;
};
/** months is the paid economic interval. A contractual scope instead covers
 * the explicitly bound calendar liability range, including pauses and tail. */
export type TaxContext = { scenario: string; from: string; through: string; months: 1 | 12; contract?: ContractTaxCoverage };
export type CustomerTaxInput = { taxReview: CustomerTaxReview | null; taxContext: TaxContext | null };
type Rate = { numerator: number; denominator: number; evidence: TaxEvidence };
export const OTHER_CUSTOMER_TAX_COMPONENTS = Object.freeze(['brazilOther', 'usFederal', 'usStates', 'consumption', 'otherJurisdictions'] as const);
type Component = { status: 'ceiling' | 'not-applicable'; usdCents: number; evidence: TaxEvidence };
export type CustomerTaxReview = {
  schema: 1; policy: 'TX-2026-10-27'; basis: 'isolated-full-rights-worst-case';
  currency: 'USD'; accountingCurrency: 'BRL';
  scope: TaxContext;
  revenueCents: number; refundableCents: number; pretaxCeilingCents: number;
  /** These explicit ceilings are supplied by a dated independent review,
   * never inferred from a live spot price or from each other's reciprocal. */
  fx: { from: string; through: string; usdToBrl: Rate; brlToUsd: Rate };
  books: { year: number; annualProfitCents: number; evidence: TaxEvidence;
    /** Complete incoming operations for this scoped calendar book; required even for []. */
    exchangeCoverage: TaxEvidence;
    exchanges: { at: string; brlCents: number; evidence: TaxEvidence }[] }[];
  /** Sources AND applicable facts are required, including the IRPF regime,
   * incoming-exchange classification and complete jurisdiction coverage. */
  irpf: TaxEvidence; iof: TaxEvidence; coverage: TaxEvidence;
  components: Record<(typeof OTHER_CUSTOMER_TAX_COMPONENTS)[number], Component>;
};

/** Bound and detach data without invoking getters, iterators or JSON hooks.
 * Work limits are internal review limits; oversize books refuse, never truncate. */
function detached(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 30_000 || depth > 12) throw Error('review work bound');
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') {
      bytes += v.length;
      // The versioned commercial snapshot is 17.9k code units; retain its exact
      // bytes rather than replacing it with a weaker fingerprint. Total work
      // remains capped at 512k code units across this detached evidence.
      if (v.length > 32_768 || bytes > 512_000) throw Error('review bytes');
      return v;
    }
    if (!v || typeof v !== 'object' || active.has(v)) throw Error('review data');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) throw Error('prototype');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(v, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1200) throw Error('array bound');
    }
    active.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string')) throw Error('symbol');
    if (keys.length > (array ? 1201 : 32)) throw Error('field bound');
    const own = (key: string) => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !Object.hasOwn(d, 'value')) throw Error('accessor or missing');
      if (!(array && key === 'length') && !d.enumerable) throw Error('non-enumerable fiscal data');
      return d.value;
    };
    let out: unknown;
    if (array) {
      const length = own('length');
      if (!Number.isSafeInteger(length) || length < 0 || length > 1200 || keys.length !== length + 1) throw Error('array bound');
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) items.push(copy(own(String(i)), depth + 1));
      out = items;
    } else {
      if (keys.length > 32) throw Error('field bound');
      const record = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) record[key] = copy(own(key), depth + 1);
      out = record;
    }
    active.delete(v);
    return out;
  }
  return copy(value, 0);
}
/** A detached evidence pair, never a fiscal approval. Both fields must be
 * explicit own enumerable data; no getter, inherited default or extra field
 * is carried into a later calculation. Semantic validation remains mandatory. */
export function captureCustomerTaxInput(value: unknown): CustomerTaxInput | null {
  try {
    const copy = detached(value);
    if (!copy || typeof copy !== 'object' || Array.isArray(copy) || Object.keys(copy).length !== 2 ||
        !Object.hasOwn(copy, 'taxReview') || !Object.hasOwn(copy, 'taxContext')) return null;
    const input = copy as CustomerTaxInput;
    if (!input.taxReview || typeof input.taxReview !== 'object' || Array.isArray(input.taxReview) ||
        !input.taxContext || typeof input.taxContext !== 'object' || Array.isArray(input.taxContext)) return null;
    return input;
  } catch { return null; }
}
const cents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const day = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function evidence(v: TaxEvidence): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && day(v.date) && text(v.source) && text(v.facts);
}
const timestamp = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const n = Date.parse(s);
  return Number.isFinite(n) && new Date(n).toISOString() === s ? n : null;
};
function context(v: TaxContext): boolean {
  if (!v || !text(v.scenario) || v.scenario.length > 128 || !day(v.from) || !day(v.through) || (v.months !== 1 && v.months !== 12) || v.from >= v.through) return false;
  if (Object.hasOwn(v, 'contract')) {
    const c = v.contract;
    if (!c || !text(c.reviewId) || !/^[A-Za-z0-9_-]{1,128}$/.test(c.reviewId) || !text(c.termsSnapshot) || !evidence(c.evidence)) return false;
    const from = timestamp(c.admissionsFrom), until = timestamp(c.admissionsUntil), through = timestamp(c.liabilitiesThrough);
    if (from === null || until === null || through === null || from > until || until >= through) return false;
    return v.from === c.admissionsFrom.slice(0, 10) &&
      v.through === new Date(Math.ceil(through / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
  }
  // Monthly/yearly anniversary intervals, end exclusive. Refuse month-end
  // overflow instead of silently clipping or accepting a date in a later month.
  const from = new Date(v.from + 'T00:00:00Z'), until = new Date(from);
  until.setUTCMonth(until.getUTCMonth() + v.months);
  return until.getUTCDate() === from.getUTCDate() && until.toISOString().slice(0, 10) === v.through && v.from < v.through;
}
function sameContext(a: TaxContext, b: TaxContext): boolean {
  if (a.scenario !== b.scenario || a.from !== b.from || a.through !== b.through || a.months !== b.months) return false;
  if (!Object.hasOwn(a, 'contract') && !Object.hasOwn(b, 'contract')) return true;
  const x = a.contract, y = b.contract;
  return !!x && !!y && x.reviewId === y.reviewId && x.termsSnapshot === y.termsSnapshot &&
    x.admissionsFrom === y.admissionsFrom && x.admissionsUntil === y.admissionsUntil && x.liabilitiesThrough === y.liabilitiesThrough &&
    x.evidence.date === y.evidence.date && x.evidence.source === y.evidence.source && x.evidence.facts === y.evidence.facts;
}
function rate(v: Rate): boolean { return !!v && cents(v.numerator) && v.numerator > 0 && cents(v.denominator) && v.denominator > 0 && evidence(v.evidence); }
const rounded = (amount: bigint, r: Rate) => (amount * BigInt(r.numerator) + BigInt(r.denominator) - BigInt(1)) / BigInt(r.denominator);

/** Preserve presence: explicitly undefined/null, inherited or computed policy
 * data must never turn into the legacy path while copying a scenario. */
export function customerTaxReviewFields(value: object): { present: boolean; taxReview?: unknown; taxContext?: unknown } {
  try {
    const review = Object.getOwnPropertyDescriptor(value, 'taxReview');
    const context = Object.getOwnPropertyDescriptor(value, 'taxContext');
    if (!review && !context && !('taxReview' in value) && !('taxContext' in value)) return { present: false };
    return { present: true,
      taxReview: review && Object.hasOwn(review, 'value') ? review.value : undefined,
      taxContext: context && Object.hasOwn(context, 'value') ? context.value : undefined };
  } catch { return { present: true }; }
}

/** Inspect the original review before an enumerable-only snapshot can erase
 * TX presence. This is a bounded shape/presence check, not a fiscal approval.
 * Non-enumerable, inherited and computed fiscal fields are never silently
 * interpreted as legacy data; getters are not invoked. */
export function customerTaxCollectionState(review: unknown): 'legacy' | 'tx' | 'unknown' {
  try {
    if (!review || typeof review !== 'object' || Array.isArray(review)) return 'unknown';
    const descriptor = Object.getOwnPropertyDescriptor(review, 'scenarios');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return 'unknown';
    const scenarios = descriptor.value;
    if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) return 'unknown';
    const proto = Object.getPrototypeOf(scenarios);
    if (proto !== Object.prototype && proto !== null) return 'unknown';
    const keys = Reflect.ownKeys(scenarios);
    if (keys.length > 32 || keys.some(key => typeof key !== 'string')) return 'unknown';
    let tx = false;
    for (const key of keys) {
      const row = Object.getOwnPropertyDescriptor(scenarios, key);
      if (!row || !row.enumerable || !Object.hasOwn(row, 'value')) return 'unknown';
      const scenario = row.value;
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) continue;
      const fields = customerTaxReviewFields(scenario);
      if (!fields.present) continue;
      for (const name of ['taxReview', 'taxContext']) {
        const field = Object.getOwnPropertyDescriptor(scenario, name);
        if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return 'unknown';
        // Check deep shape before an outer clone can erase hidden executable
        // data. The fiscal calculation still runs only in the real assessor.
        detached(field.value);
      }
      tx = true;
    }
    // Exposure readers keep separate legacy snapshots. They are not migrated
    // here: refuse TX before those snapshots could discard its presence.
    const exposureField = Object.getOwnPropertyDescriptor(review, 'fundedExposure');
    if (exposureField) {
      if (!exposureField.enumerable || !Object.hasOwn(exposureField, 'value')) return 'unknown';
      const exposure = exposureField.value;
      if (exposure && typeof exposure === 'object') {
        const casesField = Object.getOwnPropertyDescriptor(exposure, 'cases');
        if (!casesField || !casesField.enumerable || !Object.hasOwn(casesField, 'value')) return 'unknown';
        const cases = casesField.value;
        if (!cases || typeof cases !== 'object' || Array.isArray(cases)) return 'unknown';
        const exposureKeys = Reflect.ownKeys(cases);
        if (exposureKeys.length > 32 || exposureKeys.some(key => typeof key !== 'string')) return 'unknown';
        for (const key of exposureKeys) {
          const item = Object.getOwnPropertyDescriptor(cases, key);
          if (!item || !item.enumerable || !Object.hasOwn(item, 'value') || !item.value || typeof item.value !== 'object') return 'unknown';
          const worst = Object.getOwnPropertyDescriptor(item.value, 'worstCase');
          if (!worst || !worst.enumerable || !Object.hasOwn(worst, 'value')) return 'unknown';
          if (worst.value && typeof worst.value === 'object' && customerTaxReviewFields(worst.value).present) return 'unknown';
        }
      }
    }
    return tx ? 'tx' : 'legacy';
  } catch { return 'unknown'; }
}

/** Retain the original fiscal kind across outer snapshots; TX presence must
 * never be downgraded into legacy absence while capturing policy/context. */
export function customerTaxContractContextState(value: unknown): 'legacy' | 'tx' | 'unknown' {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    const d = Object.getOwnPropertyDescriptor(value, 'review');
    return d && Object.hasOwn(d, 'value') ? customerTaxCollectionState(d.value) : 'unknown';
  } catch { return 'unknown'; }
}

/** Explicit TX evidence is mandatory; an unreviewed legacy cannot fund a contract.
 * TX may fund a contract only when every present scope is bound to the exact
 * existing policy and covers the actual admission time and full liability range.
 * This shape/binding check runs on ORIGINAL data, never authenticates facts and
 * never replaces the complete fiscal assessment or financial snapshot binding. */
export function customerTaxContractContextSupported(context: unknown, policy: unknown, now = new Date()): boolean {
  try {
    const own = (value: unknown, key: string): unknown => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const d = Object.getOwnPropertyDescriptor(value, key);
      return d && Object.hasOwn(d, 'value') ? d.value : undefined;
    };
    const review = own(context, 'review'), state = customerTaxCollectionState(review);
    if (state !== 'tx') return false;
    const at = now.getTime();
    if (!Number.isFinite(at)) return false;
    const scenarios = own(review, 'scenarios');
    if (!scenarios || typeof scenarios !== 'object') return false;
    for (const key of Reflect.ownKeys(scenarios)) {
      const raw = own(scenarios, String(key));
      if (!raw || typeof raw !== 'object') return false;
      const fields = customerTaxReviewFields(raw);
      if (!fields.present) return false;
      const c = detached(fields.taxContext) as TaxContext, r = detached(fields.taxReview) as CustomerTaxReview;
      const bound = c?.contract;
      if (!c || !r || !contextValidForContract(c, String(key)) || !sameContext(c, r.scope) || !bound ||
          bound.reviewId !== own(policy, 'reviewId') || bound.termsSnapshot !== own(context, 'termsSnapshot') ||
          bound.admissionsUntil !== own(policy, 'admissionsUntil') || bound.liabilitiesThrough !== own(policy, 'liabilitiesThrough')) return false;
      const from = timestamp(bound.admissionsFrom), until = timestamp(bound.admissionsUntil);
      if (from === null || until === null || at < from || at > until) return false;
    }
    return true;
  } catch { return false; }
}
function contextValidForContract(c: TaxContext, scenario: string): boolean {
  return context(c) && Object.hasOwn(c, 'contract') && c.scenario === scenario &&
    (!scenario.endsWith('_full') || c.months === (scenario.includes('_year_') ? 12 : 1));
}

/** Reuse the annual BRL calculator, reserve whole scoped books (no guessed
 * allocation or repeated annual IRPF), then convert with explicit reviewed FX
 * ceilings. This validates supplied evidence; it cannot certify its truth. */
export function customerTaxCeiling(value: unknown, suppliedContext: unknown,
  amounts: { revenueCents: number; refundableCents: number; pretaxCents: bigint }): number | null {
  try {
    const r = detached(value) as CustomerTaxReview, c = detached(suppliedContext) as TaxContext;
    if (!r || !c || r.schema !== 1 || r.policy !== CUSTOMER_TAX_REVIEW_POLICY.id || r.basis !== CUSTOMER_TAX_REVIEW_POLICY.basis ||
        r.currency !== 'USD' || r.accountingCurrency !== 'BRL' ||
        !context(c) || !context(r.scope) || !sameContext(c, r.scope) ||
        r.revenueCents !== amounts.revenueCents || r.refundableCents !== amounts.refundableCents ||
        !cents(r.pretaxCeilingCents) || BigInt(r.pretaxCeilingCents) < amounts.pretaxCents ||
        !evidence(r.irpf) || !evidence(r.iof) || !evidence(r.coverage)) return null;
    const fx = r.fx;
    if (!fx || !day(fx.from) || !day(fx.through) || fx.from > c.from || fx.through < c.through || !rate(fx.usdToBrl) || !rate(fx.brlToUsd)) return null;
    // Mutually impossible directional ceilings would understate the reserve.
    if (BigInt(fx.usdToBrl.numerator) * BigInt(fx.brlToUsd.numerator) < BigInt(fx.usdToBrl.denominator) * BigInt(fx.brlToUsd.denominator)) return null;
    const first = Number(c.from.slice(0, 4)), last = new Date(Date.parse(c.through + 'T00:00:00Z') - 1).getUTCFullYear();
    if (!Array.isArray(r.books) || r.books.length !== last - first + 1 || r.books.length > (Object.hasOwn(c, 'contract') ? CUSTOMER_TAX_REVIEW_POLICY.maxContractBooks : CUSTOMER_TAX_REVIEW_POLICY.maxBooks)) return null;
    let totalBrl = BigInt(0), profitBrl = BigInt(0);
    for (let i = 0; i < r.books.length; i++) {
      const book = r.books[i];
      if (!book || book.year !== first + i || !cents(book.annualProfitCents) || !evidence(book.evidence) || !evidence(book.exchangeCoverage) || !Array.isArray(book.exchanges)) return null;
      const entries: number[] = [];
      for (const entry of book.exchanges) {
        if (!entry || !day(entry.at) || Number(entry.at.slice(0, 4)) !== book.year || entry.at < c.from || entry.at >= c.through || !cents(entry.brlCents) || !evidence(entry.evidence)) return null;
        entries.push(entry.brlCents);
      }
      const tax = mostCorrectTaxesOf({ currency: 'BRL', annualProfitCents: book.annualProfitCents, incomingExchangeCents: entries });
      if (!tax) return null;
      totalBrl += BigInt(tax.totalTaxCents);
      profitBrl += BigInt(book.annualProfitCents);
    }
    // A lower annual base cannot subsidize this isolated full-use scenario.
    if (profitBrl < rounded(BigInt(r.pretaxCeilingCents), fx.usdToBrl)) return null;
    let total = rounded(totalBrl, fx.brlToUsd);
    if (!r.components || Object.keys(r.components).length !== OTHER_CUSTOMER_TAX_COMPONENTS.length) return null;
    for (const key of OTHER_CUSTOMER_TAX_COMPONENTS) {
      const part = r.components[key];
      if (!part || !cents(part.usdCents) || !evidence(part.evidence) ||
          (part.status !== 'ceiling' && part.status !== 'not-applicable') ||
          (part.status === 'not-applicable' ? part.usdCents !== 0 : part.usdCents === 0)) return null;
      total += BigInt(part.usdCents);
    }
    return total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
  } catch { return null; }
}

/** Bind a commercial map key to the scenario's explicit fiscal period. */
export function customerTaxScenarioMatches(value: object, scenario: string): boolean {
  const fields = customerTaxReviewFields(value);
  if (!fields.present) return false;
  try {
    const c = detached(fields.taxContext) as TaxContext;
    return !!c && context(c) && c.scenario === scenario && (!scenario.endsWith('_full') || c.months === (scenario.includes('_year_') ? 12 : 1));
  } catch { return false; }
}
