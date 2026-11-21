export * from "./numbers-summary-retry-cost-world";
import { readStats as baseReadStats } from "./numbers-email-claim-world";
import { sendEmail as baseMail } from "./numbers-email-retry-world";
import { postToChat as basePost } from "./numbers-email-retry-world";
export const summary = {
  store: { handle: "fixture-store", name: "Fixture Store", email: "owner@example.test", statsId: "b".repeat(32), sid: "a".repeat(32), extra: false, currency: "usd", weeklyAi: true, subscriptionActive: true, trialEnds: 0 },
  afterNumbers: undefined as undefined | (() => Promise<void>),
  afterPost: undefined as undefined | (() => Promise<void>),
  afterMail: undefined as undefined | (() => Promise<void>),
};
export async function storeOf() { return { ...summary.store }; }
export async function readStats() { const answer = await baseReadStats(); await summary.afterNumbers?.(); return answer; }
export async function postToChat(url: string) { const answer = await basePost(url); await summary.afterPost?.(); return answer; }
export async function recordSample(): Promise<void> {}

export async function sendEmail(message: Parameters<typeof baseMail>[0]) { const answer = await baseMail(message); if (message.to === summary.store.email) await summary.afterMail?.(); return answer; }
export const sendEmailPinned = (message: Parameters<typeof baseMail>[0]) => sendEmail(message);
