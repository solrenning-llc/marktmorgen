// Synthetic stand-ins for the weekly and monthly numbers-email routes when a send, a post or a read fails
// (tests/numbers-email-retry.test.ts). The stores, stats and stop flags are those of numbers-email-claim-world.ts;
// this adds a sender that can refuse, a chat channel, the ad spend and the team. No network, no provider.
export * from "./numbers-email-claim-world";

export const retry = {
  /** Whether the provider takes an email to this address. */
  sendOk: (to: string): boolean => Boolean(to),
  mails: [] as string[],
  chat: "none" as "none" | "channel" | "throws",
  postOk: true,
  posts: [] as string[],
  spends: "none" as "none" | "throws",
  team: "members" as "members" | "throws",
};

export function resetRetry(): void {
  retry.sendOk = () => true;
  retry.mails.length = 0;
  retry.chat = "none";
  retry.postOk = true;
  retry.posts.length = 0;
  retry.spends = "none";
  retry.team = "members";
}

export async function sendEmail(message: { to: string; subject: string }): Promise<boolean> {
  retry.mails.push(message.to);
  return retry.sendOk(message.to);
}

export async function storeOf(folder: string) {
  return { handle: folder, name: "Fixture Store", email: "owner@example.test", statsId: "st-fixture", sid: "fixture-sid", currency: "usd", weeklyAi: false, subscriptionActive: true, trialEnds: 0 };
}

// lib/chat-summary.ts
export async function chatAddress(): Promise<string | null> {
  if (retry.chat === "throws") throw new Error("synthetic chat address read failure");
  return retry.chat === "channel" ? "https://hooks.slack.test/services/fixture" : null;
}
export const forChat = (text: string) => text;
export async function postToChat(url: string): Promise<boolean> {
  retry.posts.push(url);
  return retry.postOk;
}

// lib/ad-spend.ts
export async function readSpends(): Promise<never[]> {
  if (retry.spends === "throws") throw new Error("synthetic ad spend read failure");
  return [];
}

// lib/team.ts
const members = () => {
  if (retry.team === "throws") throw new Error("synthetic team read failure");
  return [{ email: "member@example.test", role: "editor" as const, joinedAt: "2026-10-01T00:00:00.000Z" }];
};
export async function readTeamMembers() {
  return members();
}
export async function readTeam() {
  return { members: members(), invites: [] };
}
