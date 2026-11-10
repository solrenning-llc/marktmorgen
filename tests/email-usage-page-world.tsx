import type { ReactNode } from "react";

/** Synthetic page boundaries, not a Next/auth/provider integration certificate. */
export const world: { used: unknown; throws: boolean; window: string | null; redis: boolean; list: string | null; reads: number; args: unknown[] } = {
  used: 0, throws: false, window: "synthetic-period", redis: true, list: "synthetic-list", reads: 0, args: [],
};
export function reset() { Object.assign(world, { used: 0, throws: false, window: "synthetic-period", redis: true, list: "synthetic-list", reads: 0, args: [] }); }
export function agreementsAllowed() { return false; }
export function requestsOpen() { return false; }
export const MAIL_TEMPLATES = [];
export function serializeMailBlocks() { return ""; }
export function storeBase() { return "https://example.com"; }
export function starterFlows() { return []; }
export function sellsSomething() { return false; }
export function windowId() { return world.window; }
export const WHO = [];
export function lookColours() { return { accent: "#000000" }; }
export function aiAvailableFor() { return false; }
export async function aiLeft() { throw Error("AI must not be read in this proof"); }
export function productLink() { return ""; }
export function idsOfKind() { return []; }
export async function readTitles() { return new Map(); }
export async function cookies() { return {}; }
export function redirect() { throw Error("unexpected redirect"); }
export const PLANS_ON_SALE = false;
export function studioPath() { return "/studio"; }
export async function studioView() {
  return { ok: true, view: { role: "editor", stores: [], owned: [], email: "owner@example.com", store: {
    sid: "synthetic-store", listId: world.list, statsId: "synthetic-stats", handle: "harbor", name: "Harbor",
    mail: null, email: "owner@example.com", tier: "pro", subscriptionActive: true, currency: "usd", look: {},
  } } };
}
export function StudioHeader() { return null; }
export function StudioStorePin({ children }: { children: ReactNode }) { return <>{children}</>; }
export function EmailStudio({ used, monthKnown }: { used: number | null; monthKnown: boolean }) {
  return <div id="synthetic-composer" data-used={used === null ? "unknown" : used} data-month-known={String(monthKnown)}>Draft editor preserved</div>;
}
export async function listCounts() { return { total: 0, agreed: 0, left: 0, mailable: 0 }; }
export async function listBroadcastsStrict() { return []; }
export function letterIdFor() { return ""; }
export async function publishedLetters() { return new Map(); }
export function broadcastMoney() { return null; }
export function flowMoney() { return null; }
export async function readMailRevenue() { throw Error("no sent email, no revenue read"); }
export async function readMailVisits() { return null; }
export async function readFlowStatsStrict() { return new Map(); }
export async function readFlowListStrict() { return []; }
export function inTrial() { return false; }
export function monthlyAllowance() { return 10_000; }
export function isRedisConfigured() { return world.redis; }
export async function usedThisMonthExact(...args: unknown[]) { world.reads++; world.args = args; if (world.throws) throw Error("synthetic unread counter"); return world.used; }
export function healthId() { return "synthetic-health"; }
export async function listHealth() { return null; }
export async function pauseForSending() { return null; }
export function pauseWords() { return ""; }
export async function pausedFor() { return null; }
export const HEALTH_NOTE = "";
export function healthAdvice() { return null; }
export function healthLevels() { return null; }
export function healthLine() { return ""; }
export const PRO_MONTHLY_EMAILS = 10_000, SCALE_MONTHLY_EMAILS = 20_000, TRIAL_MONTHLY_EMAILS = 100, TRIAL_DAYS = 14;
export const PRO_ON_SALE = false;
export function hasPro() { return true; }
export function publishedPriceWords() { return "synthetic price"; }
export function publishedYearSaving() { return 0; }
export function emailEquivalence() { return ""; }
export async function readForms() { return []; }
export async function readFields() { return []; }
export async function readPipelines() { return []; }
export function labeledStages() { return []; }
export async function listDraftsStrict() { return []; }
export function can() { return false; }
export function isBillingConfigured() { return false; }
export function trialOffered() { return false; }
export function planDisputed() { return false; }
export async function listSegments() { return []; }
export function activeFlowLimit() { return 1; }
export function dailyRunLimit() { return 1; }
export async function listHeld() { return []; }
export async function runsToday() { return null; }
export async function readTeam() { return { members: [] }; }
