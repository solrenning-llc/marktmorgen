// Synthetic stand-ins for tests/numbers-summary-retry-cost.test.ts: the numbers-email retry world with the weekly AI
// lead on, so a week tried again can be seen taking (or not taking) another of the creator's AI writing jobs. Each
// call of weeklySummary stands for one job taken from the store's monthly allowance (lib/ai.ts counted). No network.
export * from "./numbers-email-retry-world";
import { storeOf as retryStore } from "./numbers-email-retry-world";

export const ai = { jobs: 0 };
export async function weeklySummary(): Promise<string | null> {
  ai.jobs += 1;
  return "A synthetic lead written from the week's numbers.";
}
export function aiAvailableFor(): boolean {
  return true;
}
export async function storeOf(folder: string) {
  return { ...(await retryStore(folder)), weeklyAi: true };
}
