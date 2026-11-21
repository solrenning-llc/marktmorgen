/**
 * The studio's words for applications to buy (604 [WP3]): the same sentences
 * from the route that decides (app/api/store/applications/route.ts) and the
 * page that shows them (components/apply-first-studio.tsx), in plain US
 * English. No I/O.
 */
import type { ApplicationState } from "@/lib/apply-first-rules";

/** Each refusal of a decision, as the creator reads it. */
export const DECIDE_WORDS = {
  invalid: "That is not something this page can do. Reload the page.",
  gone: "That application is gone. Reload the page to see the list as it is now.",
  days: "Choose how long the buy link works: from 1 to 30 days.",
  final: "This application was declined, or its link was used, so it can't change now.",
  still_open: "Its buy link still works. You can approve it again after the link ends.",
  changed: "This application changed while you were deciding, so nothing was saved. Reload the page to see it now.",
  unknown: "We could not confirm whether your answer was saved. Reload the page to check before you try again.",
} as const;

export type DecideRefusal = keyof typeof DECIDE_WORDS;

/** Where an application stands, in a few words. An approval whose link has ended says so. */
export function stateWords(state: ApplicationState, expiresAt: number, now: number): string {
  if (state === "submitted") return "Waiting for your answer";
  if (state === "declined") return "Declined";
  if (state === "used") return "Buy link used";
  return now < expiresAt ? "Approved" : "Approved, buy link ended";
}

/** A day as the studio writes it ("Nov 10, 2026"), in UTC, so the server and the browser write the same. */
export function dayWords(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** What an approval answers, with nothing promised that is not done: no email is sent yet. */
export function approvedWords(days: number, expiresAt: number): string {
  return `Approved. The buy link works for ${days} ${days === 1 ? "day" : "days"}, until ${dayWords(expiresAt)} (UTC). Nothing was emailed: sending the link is not available yet.`;
}

export const DECLINED_WORDS = "Declined. Nothing was emailed.";
