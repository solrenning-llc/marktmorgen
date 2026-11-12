/**
 * Closing a deal from the board asks first (553 [DB1], unit 1; added 12
 * November 2026), and each column says how many deals it holds in words.
 * Browser-safe and pure; components/deals-board.tsx draws the question.
 *
 * Moving a deal into a stage that counts as won or lost closes it: its amount
 * starts counting as won (or stops counting as open), and a sequence that
 * starts at that stage may start for the deal's person (lib/flows.ts, "stage"). So the move waits for a second press, with the safer choice
 * first, as removing a deal already does (WCAG 3.3.6). Moving between open
 * stages, or from one won stage to another, is not closing and asks nothing.
 */
import type { StageKind } from "@/lib/crm-rules";

/** Whether moving from a stage of kind `from` to one of kind `to` closes the deal. */
export function closesDeal(from: StageKind | undefined, to: StageKind | undefined): boolean {
  return (to === "won" || to === "lost") && from !== to;
}

/** The question shown before a deal is closed: its title, the line under it, and the two buttons, the safer one first. */
export function closeWords(input: { kind: "won" | "lost"; title: string; stage: string; amount: string | null }): { question: string; text: string; keep: string; close: string } {
  const counted = input.kind === "won" ? (input.amount ? `its ${input.amount} counts as won` : "it counts as won") : "it counts as lost and no longer as open";
  return {
    question: `Close “${input.title}” as ${input.kind}?`,
    text: `It moves to ${input.stage} and ${counted}. If a sequence you switched on starts at that stage, it starts for this deal's person when they are on your list and agreed to hear from you.`,
    keep: "Keep it where it is",
    close: input.kind === "won" ? "Close as won" : "Close as lost",
  };
}

/** How many deals a column holds, in words: "1 deal", "12 deals". */
export const dealCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "deal" : "deals"}`;
