/** Synthetic service boundaries around the actual Path page; the week and streak rules stay real. */
import type { ReactNode } from "react";
import type { PathRecord } from "../lib/path";
import type { Store } from "../lib/store";
import { NO_FACTS } from "../lib/path-rules";

type Mode = "record" | "absent" | "read-failed" | "visit-failed" | "returning";
let mode: Mode = "record";
let record: PathRecord;
export const calls = { cookies: 0, studioView: 0, readPath: 0, visitPath: 0, allowanceUsed: 0, readGrowth: 0, readBoard: 0, chargeStudio: 0 };
export function configure(checkins: string[], timeZone = "America/New_York", nextMode: Mode = "record") {
  mode = nextMode;
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
  record = {
    answers: { goalCents: 0, goalCurrency: "usd", skills: "Bread", subject: "Baking", minutes: 15, audience: "none", timeZone },
    startedAt: Date.UTC(2025, 0, 1), checkins: [...checkins], best: -1, bestAt: 0,
    money: { at: Date.UTC(2026, 10, 1), test: false, real: 99, cents: 987654321, currency: "usd" }, counts: null,
  };
}
export function savedCheckins() { return [...record.checkins]; }
const store = { sid: "a".repeat(32), handle: "weeklypath", name: "Fictional weekly Path", currency: "usd" } as Store;
export async function cookies() { calls.cookies++; return {}; }
export function redirect(): never { throw new Error("Synthetic redirect"); }
export async function studioView() { calls.studioView++; return { ok: true, view: { store, role: "owner", stores: [store], owned: [] } }; }
export function studioPath(_store?: unknown, query = "", page = "") { return `/studio${page ? "/" + page : ""}?store=${store.sid}${query ? "&" + query : ""}`; }
export async function readPath() { calls.readPath++; if (mode === "read-failed") throw new Error("Synthetic read failure"); return mode === "absent" ? null : record; }
export async function visitPath() { calls.visitPath++; if (mode === "visit-failed") throw new Error("Synthetic visit failure"); return { record, facts: { ...NO_FACTS, titlePublished: true } }; }
export function returnMissionFor() { return mode === "returning" ? { state: "open", title: "Give your store's introduction one clear update", why: "One useful step.", steps: ["Review your introduction."], closesOn: "An updated introduction.", place: { label: "Edit your store's introduction", hash: "#details" } } : null; }
export function chargeStudio() { calls.chargeStudio++; throw new Error("Unexpected charge"); }
export async function allowanceUsed() { calls.allowanceUsed++; return 0; }
export async function allowanceUsedExact() { calls.allowanceUsed++; return 0; }
export function allowanceFor() { return 100; }
export function pathPlanLine() { return null; }
export function largerPlanFor() { return null; }
export function aiAvailableFor() { return false; }
export function currentWordingSource() { throw new Error("Unexpected AI wording"); }
export function pathScriptProducts() { return []; }
export function readPathGrowth() { calls.readGrowth++; throw new Error("Unexpected growth reading"); }
export function readPathBoardRows() { calls.readBoard++; throw new Error("Unexpected board reading"); }
export const PLANS_ON_SALE = false;
export function canSell() { return false; }
export function sellsInTestMode() { return false; }
export function pathCampaign() { return null; }
function Empty() { return null; }
export { Empty as PathCertificates, Empty as PathAiWording, Empty as PathSocialScripts, Empty as PathGrowthMissions, Empty as PathBoard, Empty as PathCheckoutNotice, Empty as PathMissions, Empty as PathReminderButton, Empty as PathShareCard, Empty as StudioHeader };
export function StudioStorePin({ children }: { children: ReactNode }) { return <>{children}</>; }
export function PathOnboarding() { return <p>Choose your Path answers.</p>; }
export default function Link({ children, href, className }: { children: ReactNode; href: string; className?: string }) { return <a href={href} className={className}>{children}</a>; }
