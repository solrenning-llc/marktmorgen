/**
 * How long a partnership lasts, who may change it and what it went through
 * (630 [HN6](39), unit 1; owner's Hotmart audit). A partner's share
 * (lib/partner-share.ts) runs either to a date the creator chose or "until
 * revoked". Once agreed, the creator cannot change it alone: a new
 * percentage, other products or another end waits for the partner's yes,
 * and a share that runs to a date cannot be ended before it without that yes
 * either. Only a share "until revoked" can be ended by the creator alone,
 * because that is what both agreed to. Either way, what was already earned is
 * never touched: each earning keeps the percentage it was made at.
 *
 * Every step is kept in a short history both of them can read: started,
 * changed, ended, revoked, and a change the partner declined or that expired
 * unanswered.
 *
 * Pure and browser-safe; nothing reads it yet. Unit 2 keeps the waiting
 * change and the history on the partner's record (lib/affiliates.ts), checks
 * the cap again when the partner says yes, and asks the partner on their own
 * page; unit 3 shows it in the studio.
 */
import type { PartnerShare } from "@/lib/partner-share";

/** The latest end a creator may choose, in days from today. */
export const MAX_TERM_DAYS = 3650;
/** How long a change waits for the partner's answer before it lapses, in seconds. */
export const CHANGE_WAITS_SECONDS = 30 * 24 * 60 * 60;
/** The most steps kept in one partnership's history; the oldest go first. */
export const MAX_TERM_HISTORY = 50;

const DAY = 24 * 60 * 60;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The end a creator typed, as seconds, or null for "until revoked". A date
 * (YYYY-MM-DD, from a date field) means the share earns through that whole
 * day, so it ends at the start of the next one, in UTC. The date has to be
 * after today and at most MAX_TERM_DAYS away; anything else is refused.
 */
export function readTermEnd(raw: unknown, nowSeconds: number): { ok: true; until: number | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "" || raw === "revoked") return { ok: true, until: null };
  if (typeof raw !== "string") return { ok: false };
  const m = DATE.exec(raw.trim());
  if (!m) return { ok: false };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = Date.UTC(y, mo - 1, d);
  const back = new Date(start);
  // 2027-02-30 is not a day; Date would quietly make it March 2.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return { ok: false };
  const until = start / 1000 + DAY;
  if (until <= nowSeconds + DAY) return { ok: false };
  if (until > nowSeconds + (MAX_TERM_DAYS + 1) * DAY) return { ok: false };
  return { ok: true, until };
}

/** Whether a share still earns on a sale paid now. */
export function shareRunning(share: PartnerShare | null, nowSeconds: number): boolean {
  return share !== null && (share.until === undefined || nowSeconds < share.until);
}

function sameProducts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Whether two shares are the same agreement: percentage, products and end. */
export function sameShare(a: PartnerShare, b: PartnerShare): boolean {
  return a.percent === b.percent && sameProducts(a.products, b.products) && (a.until ?? null) === (b.until ?? null);
}

/**
 * What a creator's save does to an agreed share. `next` null is ending it.
 * - "same": nothing changes;
 * - "now": applies at once (ending a share "until revoked", or one already over);
 * - "ask": waits for the partner's yes.
 */
export function changeNeeds(current: PartnerShare, next: PartnerShare | null, nowSeconds: number): "same" | "now" | "ask" {
  if (!shareRunning(current, nowSeconds)) return next === null ? "now" : "ask";
  if (next === null) return current.until === undefined ? "now" : "ask";
  return sameShare(current, next) ? "same" : "ask";
}

/** A change waiting for the partner: the share it proposes (null ends it) and when it was asked, in seconds. */
export type WaitingChange = { share: PartnerShare | null; asked: number };

/** Whether a waiting change can still be answered. */
export function changeOpen(change: WaitingChange | null, nowSeconds: number): change is WaitingChange {
  return change !== null && nowSeconds < change.asked + CHANGE_WAITS_SECONDS;
}

export type TermStep = {
  /** Seconds. */
  at: number;
  by: "creator" | "partner";
  kind: "started" | "asked" | "changed" | "declined" | "lapsed" | "revoked";
  /** The share after this step, or the one asked for; null when it was ended. */
  percent: number | null;
  products: number;
  until: number | null;
};

const KINDS = new Set<TermStep["kind"]>(["started", "asked", "changed", "declined", "lapsed", "revoked"]);

/** One step from a share, for the history. */
export function stepOf(kind: TermStep["kind"], by: TermStep["by"], share: PartnerShare | null, atSeconds: number): TermStep {
  return { at: atSeconds, by, kind, percent: share ? share.percent : null, products: share ? share.products.length : 0, until: share?.until ?? null };
}

/** The history with one more step, the newest last, never longer than MAX_TERM_HISTORY. */
export function withStep(history: TermStep[], step: TermStep): TermStep[] {
  return [...history, step].slice(-MAX_TERM_HISTORY);
}

/** A kept history, made safe: unknown steps dropped, oldest first, capped. */
export function readHistory(raw: unknown): TermStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: TermStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) continue;
    if (v.by !== "creator" && v.by !== "partner") continue;
    if (typeof v.kind !== "string" || !KINDS.has(v.kind as TermStep["kind"])) continue;
    const percent = typeof v.percent === "number" && Number.isInteger(v.percent) && v.percent > 0 && v.percent <= 100 ? v.percent : null;
    const products = typeof v.products === "number" && Number.isInteger(v.products) && v.products >= 0 ? Math.min(v.products, 200) : 0;
    const until = typeof v.until === "number" && Number.isSafeInteger(v.until) && v.until > 0 ? v.until : null;
    steps.push({ at: v.at, by: v.by, kind: v.kind as TermStep["kind"], percent, products, until });
  }
  return steps.sort((a, b) => a.at - b.at).slice(-MAX_TERM_HISTORY);
}

const longDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The last day a share earns on, in words: the day before `until`. */
export function lastDayWords(until: number): string {
  return longDate(until - DAY);
}

/** How long a share runs, in a few plain words. */
export function termWords(share: PartnerShare, nowSeconds: number): string {
  if (share.until === undefined) return "Until you or they end it";
  return nowSeconds < share.until ? `Through ${lastDayWords(share.until)}` : `Ended after ${lastDayWords(share.until)}`;
}

const productWords = (n: number) => (n === 1 ? "1 product" : `${n} products`);

/** One step of the history as a sentence, for the creator and the partner alike. */
export function stepWords(step: TermStep): string {
  const who = step.by === "creator" ? "the store" : "the partner";
  const what = step.percent === null ? "" : `${step.percent}% of ${productWords(step.products)}, ${step.until === null ? "until ended" : `through ${lastDayWords(step.until)}`}`;
  switch (step.kind) {
    case "started":
      return `${longDate(step.at)}: started at ${what}.`;
    case "asked":
      return step.percent === null ? `${longDate(step.at)}: ${who} asked to end it.` : `${longDate(step.at)}: ${who} asked to change it to ${what}.`;
    case "changed":
      return step.percent === null ? `${longDate(step.at)}: ended, agreed by both.` : `${longDate(step.at)}: changed to ${what}, agreed by both.`;
    case "declined":
      return `${longDate(step.at)}: the partner said no to the change. The terms before it still hold.`;
    case "lapsed":
      return `${longDate(step.at)}: the change was not answered in 30 days. The terms before it still hold.`;
    case "revoked":
      return `${longDate(step.at)}: ${who} ended it. What was already earned is still paid.`;
  }
}
