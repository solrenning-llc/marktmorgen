/**
 * What moving to Marktmorgen may use in a calendar month (UTC), per plan:
 * the imports of lib/imports.ts and their dry runs, and the ClickFunnels
 * funnel migration (lib/clickfunnels-funnel.ts). Browser-safe, so the studio
 * prints the figures the routes enforce (app/api/store/import,
 * app/api/store/import/funnel).
 *
 * Added 17 October 2026. Until then these paths had thirty-day windows sized
 * for convenience (10,000 dry-run batches, 1,500 funnel dry runs, 300 saved
 * pages a day), and the rows an import brings had no monthly figure at all.
 * Each costs database commands and transfer (tests/plan-cost-registry.ts has
 * the arithmetic), and every plan's worst month has to keep the owner's 60%
 * after tax with every allowance used in full, so each now has a calendar
 * month figure sized to what moving a store takes:
 *
 *   rows          rows an import may bring in, all kinds together (contacts,
 *                 products, past buyers, members), counted as they arrive,
 *                 each upload counting at least IMPORT_MIN_ROWS_PER_UPLOAD
 *   starts        imports started
 *   steps         times the studio's page asks for the next part of the work
 *                 (past them the five-minute job still finishes every import)
 *   reports       downloads of the rows that were not brought in
 *   checks        dry-run batches of contacts or products (1,000 rows each)
 *   buyerChecks   dry-run batches of past buyers, which read every product
 *                 they name and so cost more
 *   pageReads     saved ClickFunnels pages read for a funnel migration
 *   funnelChecks  funnel migration dry runs
 *   funnelSaves   funnel migrations saved
 *   movedEmails   the one email to each buyer or member brought over, on a
 *                 plan with no monthly email allowance; on Studio and Scale
 *                 those emails come out of the plan's monthly emails instead
 *                 (lib/mail.ts, reserve)
 *
 * A store in its free trial, or with no plan, has Store's figures. So does a
 * paid plan whose renewal is unpaid or whose payment is disputed
 * (lib/plan-standing.ts costStandingOf, 232 [CA1] unit 4b2), although no
 * import starts, checks or runs until that is settled (lib/imports.ts
 * runImport, app/api/store/import and app/api/store/import/funnel); the one
 * exception is rows, where an upload already under way keeps its plan's
 * own month (importRowsFor).
 */
import type { Tier } from "@/lib/plan";
import { type PlanFields, costStandingOf, standingOf } from "@/lib/plan-standing";

export type ImportAllowance = {
  rows: number;
  starts: number;
  steps: number;
  reports: number;
  checks: number;
  buyerChecks: number;
  pageReads: number;
  funnelChecks: number;
  funnelSaves: number;
  movedEmails: number;
};

export const IMPORT_ALLOWANCES: Record<Tier, ImportAllowance> = {
  creator: { rows: 1_000, starts: 20, steps: 100, reports: 20, checks: 60, buyerChecks: 10, pageReads: 50, funnelChecks: 50, funnelSaves: 5, movedEmails: 20 },
  pro: { rows: 8_000, starts: 60, steps: 300, reports: 60, checks: 200, buyerChecks: 30, pageReads: 150, funnelChecks: 150, funnelSaves: 15, movedEmails: 0 },
  scale: { rows: 20_000, starts: 100, steps: 600, reports: 100, checks: 300, buyerChecks: 60, pageReads: 150, funnelChecks: 150, funnelSaves: 15, movedEmails: 0 },
};

/** The figures a store has right now: its plan's while it is paid up and its costs are not paused, Store's otherwise. */
export function importAllowanceFor(store: PlanFields & { tier: Tier }, nowSeconds = Date.now() / 1000): ImportAllowance {
  return costStandingOf(store, nowSeconds) === "paid" ? IMPORT_ALLOWANCES[store.tier] ?? IMPORT_ALLOWANCES.creator : IMPORT_ALLOWANCES.creator;
}

/**
 * The rows an upload may bring in a month: the plan's own while it is paid
 * up, even while its costs are paused (only an upload already under way can
 * send rows then, and its plan's month bounds them), Store's otherwise.
 */
export function importRowsFor(store: PlanFields & { tier: Tier }, nowSeconds = Date.now() / 1000): number {
  return standingOf(store, nowSeconds) === "paid" ? (IMPORT_ALLOWANCES[store.tier] ?? IMPORT_ALLOWANCES.creator).rows : IMPORT_ALLOWANCES.creator.rows;
}

/**
 * Review ceilings for the arithmetic (not measured averages): the database
 * commands one imported row may cost (its repeat check, its record, its
 * contact or purchase, its counters and its line in the report), and the
 * bytes it moves (stored as it arrives, read back by the step that applies
 * it, written where it lands).
 */
export const IMPORT_WORST_COMMANDS_PER_ROW = 6;
/** The fewest rows an upload counts as, so the requests an allowance can start are bounded by it. */
export const IMPORT_MIN_ROWS_PER_UPLOAD = 50;
/**
 * The most an upload keeps in the database for each row it counts as, in
 * bytes (since 18 October 2026): an upload counts at least one row for every
 * this many bytes it carries, so what imports keep while they run is bounded
 * by the rows figure (tests/store-data-registry.ts), however long the cells.
 */
export const IMPORT_ROW_BYTES = 2_000;
export const IMPORT_WORST_BYTES_PER_ROW = 3_000;

/**
 * How long rows not brought in yet are kept from their upload (lib/imports.ts
 * RAW_DAYS, which tests/import-paused.test.ts holds equal to this), for the
 * words below.
 */
export const IMPORT_ROWS_KEPT_DAYS = 3;

/**
 * What the studio says when an import or a funnel migration is refused
 * because the plan's renewal is unpaid or a payment for it is disputed
 * (232 [CA1] unit 4b2), in place of the studio's words about uploads.
 */
export const IMPORTS_PAUSED = {
  renewal_unpaid: `Your plan's renewal payment did not go through, so imports are paused. Check the notice at the top of your studio to pay it. An import already started goes on where it stopped once it is paid, and what it already brought in stays. Rows not brought in yet are kept ${IMPORT_ROWS_KEPT_DAYS} days from their upload; after that, start again with the rows not brought in.`,
  plan_disputed: `A payment for your plan is disputed with your bank, so imports are paused. Check the notice at the top of your studio for what happens next. An import already started goes on where it stopped if everything starts again, and what it already brought in stays. Rows not brought in yet are kept ${IMPORT_ROWS_KEPT_DAYS} days from their upload; after that, start again with the rows not brought in.`,
} as const;

/** The same, for a ClickFunnels funnel migration, which keeps no rows. */
export const FUNNEL_PAUSED = {
  renewal_unpaid: "Your plan's renewal payment did not go through, so funnel imports are paused. Check the notice at the top of your studio to pay it; you can import the funnel once it is paid. Pages already made stay as they are.",
  plan_disputed: "A payment for your plan is disputed with your bank, so funnel imports are paused. Check the notice at the top of your studio for what happens next. Pages already made stay as they are.",
} as const;

/** "2,000 rows", for the studio. */
export function rowsWords(rows: number): string {
  return `${Math.max(0, Math.floor(rows)).toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"}`;
}

/** The figures in one sentence, for the import page and the help center. */
export function importAllowanceWords(): string {
  const { creator, pro, scale } = IMPORT_ALLOWANCES;
  const n = (v: number) => v.toLocaleString("en-US");
  return `Rows an import brings in, a billing month: ${n(creator.rows)} on Store, ${n(pro.rows)} on Studio, ${n(scale.rows)} on Scale (Store's figures in the free trial and before a plan), each upload counting at least ${IMPORT_MIN_ROWS_PER_UPLOAD} rows, and one row for every ${n(IMPORT_ROW_BYTES)} bytes it carries; imports started: ${n(creator.starts)}, ${n(pro.starts)} and ${n(scale.starts)}.`;
}
