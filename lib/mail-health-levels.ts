/**
 * How a store's email is doing, said to the creator before anything pauses
 * (599 [KB20], unit 1; added 1 November 2026).
 *
 * The pause itself is lib/mail-health.ts: over HEALTH_WINDOW_DAYS days, at
 * least BOUNCE_FLOOR bounces and BOUNCE_RATE of what was sent, or at least
 * COMPLAINT_FLOOR spam reports and COMPLAINT_RATE of it, pauses the list's
 * email for PAUSE_DAYS days. Nothing here changes those lines or loosens any
 * of them: it reads the same seven days and says how near each one is, so a
 * creator hears "close" before they hear "paused".
 *
 *   fine     under half of the line on both counts
 *   watch    half of the line or more, in the number and in the share
 *   near     four fifths of the line or more, in the number and in the share
 *   over     at the line (overTheLine): the next bounce or spam report the
 *            sender tells us about pauses the list's email
 *
 * Browser-safe: plain data and pure functions over the rules' own numbers.
 */
import { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE, HEALTH_WINDOW_DAYS, PAUSE_DAYS } from "@/lib/mail-health-rules";

export type HealthCounts = { sent: number; bounced: number; complained: number };
export type HealthLevel = "fine" | "watch" | "near" | "over";
export type HealthMeasure = "bounces" | "complaints";

const ORDER: HealthLevel[] = ["fine", "watch", "near", "over"];

function levelOf(count: number, sent: number, floor: number, rate: number): HealthLevel {
  if (sent <= 0 || count <= 0) return "fine";
  const share = count / sent;
  const reached = (part: number) => count >= floor * part && share >= rate * part;
  return reached(1) ? "over" : reached(0.8) ? "near" : reached(0.5) ? "watch" : "fine";
}

/** Each measure's level, and the worse of the two. */
export function healthLevels(health: HealthCounts): { bounces: HealthLevel; complaints: HealthLevel; worst: HealthLevel; measure: HealthMeasure | null } {
  const bounces = levelOf(health.bounced, health.sent, BOUNCE_FLOOR, BOUNCE_RATE);
  const complaints = levelOf(health.complained, health.sent, COMPLAINT_FLOOR, COMPLAINT_RATE);
  const worst = ORDER[Math.max(ORDER.indexOf(bounces), ORDER.indexOf(complaints))];
  // Bounces first, as the pause looks at them first.
  const measure = worst === "fine" ? null : ORDER.indexOf(bounces) >= ORDER.indexOf(complaints) ? "bounces" : "complaints";
  return { bounces, complaints, worst, measure };
}

/**
 * A share as shown: rounded down at the place shown, so a rate just under a
 * line never reads as the line itself, and "<0.01%" rather than 0% when
 * there is one.
 */
export function shareWords(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const percent = (part / whole) * 100;
  const places = percent < 1 ? 2 : 1;
  const floored = Math.floor(percent * 10 ** places) / 10 ** places;
  return floored <= 0 ? "<0.01%" : `${floored.toFixed(places)}%`;
}

/** The counted days' numbers, in a sentence that says what is counted. */
export function healthLine(health: HealthCounts): string {
  const counted = `Email to your list, and the one email to buyers you brought over, in the last ${HEALTH_WINDOW_DAYS} days (counting starts again when a pause ends)`;
  if (health.sent <= 0) return `${counted}: none sent.`;
  return `${counted}: ${health.sent.toLocaleString("en-US")} sent, ${health.bounced.toLocaleString("en-US")} to addresses that do not exist (${shareWords(health.bounced, health.sent)}), ${health.complained.toLocaleString("en-US")} reported as spam (${shareWords(health.complained, health.sent)}).`;
}

/** What the level means and what to do, in plain words. */
export function healthAdvice(level: HealthLevel, measure: HealthMeasure | null): { title: string; text: string } {
  if (level === "fine" || !measure) return { title: "No pause coming", text: "Bounces and spam reports are well under the level that pauses email to your list." };
  const what =
    measure === "bounces"
      ? "Some of your emails go to addresses that do not exist. This usually comes from a list brought in from somewhere else."
      : "Some people mark your emails as spam. This usually means they did not expect to hear from you.";
  const fix =
    measure === "bounces"
      ? "Before you bring in more addresses, check where they came from, and write only to people who asked to hear from you. An address that bounces for good is never written to again by itself."
      : "Write only to people who asked, say who you are at the top, and keep the unsubscribe link easy to find.";
  if (level === "over") return { title: "At the level that pauses", text: `${what} The next bounce or spam report we hear about pauses email to your list for ${PAUSE_DAYS} days; it then goes on by itself. ${fix}` };
  if (level === "near") return { title: "Close to a pause", text: `${what} A little more and email to your list pauses for ${PAUSE_DAYS} days. ${fix}` };
  return { title: "Worth a look", text: `${what} You are at half or more of the level that pauses email to your list. ${fix}` };
}

/** Said under the numbers: what reaches us, and what a pause does and does not stop. */
export const HEALTH_NOTE =
  "Spam reports reach us only from email providers that send them back to the sender, so a low number here is not a promise that nobody reported you. Sign-in links and purchase receipts are never paused; while a pause lasts, email to your list, your sequences and the email to buyers you brought over wait.";
