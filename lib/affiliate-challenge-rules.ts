/**
 * Challenges for affiliates (384 [TB10], unit 1). Stub: the rules come in the
 * next commit.
 */
import type { Book, Row } from "@/lib/affiliates";

export const CHALLENGE_MAX_TITLE = 80;
export const CHALLENGE_MAX_DAYS = 92;
export const CHALLENGE_SETTLE_DAYS = 30;

export type ChallengePrize = { kind: "product" | "access" | "coupon"; label: string };
export type Challenge = { title: string; start: number; end: number; goal: number; places: number; products: string[]; prize: ChallengePrize; excluded?: string[] };
export type ChallengeProblem = "title" | "dates" | "winners" | "prize" | "products";
export type Standing = { aff: string; sales: number; reachedAt: number; place: number; wins: boolean };
export type BoardRow = { place: number; label: string; sales: number; you: boolean; wins: boolean };

export function readChallenge(_raw: unknown, _nowMs: number): { ok: true; challenge: Challenge } | { ok: false; problem: ChallengeProblem } {
  return { ok: false, problem: "title" };
}

export function challengePhase(_c: Challenge, _nowMs: number): "upcoming" | "running" | "settling" | "over" {
  return "upcoming";
}

export function challengeStandings(_c: Challenge, _book: Pick<Book, "lines" | "rows" | "refundsChecked">): { ok: true; standings: Standing[]; review: string[] } | { ok: false; problem: "refunds" } {
  void ([] as Row[]);
  return { ok: true, standings: [], review: [] };
}

export function challengeBoard(_s: Standing[], _viewer: string, _names: Record<string, string>, _top = 10): { rows: BoardRow[]; mine: { place: number | null; sales: number } } {
  return { rows: [], mine: { place: null, sales: 0 } };
}

export function readBoardName(_raw: unknown): string | null {
  return null;
}

export function challengeNotes(_c: Challenge, _nowMs: number): string[] {
  return [];
}
