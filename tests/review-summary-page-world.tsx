/** Explicit synthetic auth/service/component boundaries around the actual reviews page. */
import type { ReactNode } from "react";
import { UnknownReplyError } from "../lib/redis-reply";
let mode: "unknown" | "healthy" | "empty" = "healthy";
export const configure = (value: typeof mode) => { mode = value; };
const shop = { statsId: "synthetic-summary", sid: "a".repeat(32), handle: "summaryproof", name: "Fictional summary store", reviewAsk: { days: 0 } };
export async function cookies() { return {}; }
export function redirect(): never { throw new Error("Synthetic redirect"); }
export async function studioView() { return { ok: true, view: { store: shop, role: "owner", stores: [shop], owned: [] } }; }
export const studioPath = () => "/studio/reviews";
export const productIds = () => ["lesson"];
export const readListings = async () => [{ id: "lesson", title: "Fictional lesson" }];
export const studioReviews = async () => ({ rows: [], total: 0, unseen: 0 });
export const summaries = async () => new Map([["lesson", { count: 5, visible: 5, hidden: 0, refunded: 0, stars: 25 }]]);
export const reviewsSince = async () => null;
export const averageText = () => "5.0";
export const showsRating = () => true;
export const HIDDEN_RULE = "Synthetic hiding rule.";
export const OVERVIEW_READ_MAX = 500;
export const readVoice = async () => null;
export const canRecover = () => false;
export const storeBase = () => "https://example.test";
export const canWrite = () => false;
export const aiAvailableFor = () => false;
export const aiLeft = async () => { throw new Error("Unexpected AI read"); };
export async function readReviewSummaries() {
  if (mode === "unknown") throw new UnknownReplyError("synthetic summary read");
  return new Map([["lesson", { summary: mode === "healthy" ? { at: 1793952000, read: 5, themes: [] } : null, lastAt: mode === "healthy" ? 1793952000 : 0 }]]);
}
export const StudioHeader = () => null;
export function StudioStorePin({ children }: { children: ReactNode }) { return <>{children}</>; }
export function AiOn({ children }: { children: ReactNode }) { return <>{children}</>; }
export const ReviewAskEditor = () => null;
export const ReviewRow = () => null;
export const SeenAllButton = () => null;
export const ReviewQr = () => null;
export const ReviewThemes = () => null;
export function ReviewAiSummaries({ products }: { products: { id: string; summary: { at: number } | null; lastAt: number }[] }) {
  return <section data-summary-slot="true">{products.map(p => <p key={p.id} data-summary-at={p.summary?.at ?? "none"} data-week-at={p.lastAt} />)}</section>;
}
