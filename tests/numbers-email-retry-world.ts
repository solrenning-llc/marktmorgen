// Synthetic stand-ins for the weekly and monthly numbers-email routes when a send, a post or a read fails
// (tests/numbers-email-retry.test.ts). The stores, stats and stop flags are those of numbers-email-claim-world.ts;
// this adds a sender that can refuse, a chat channel, the ad spend and the team. No network, no provider.
export * from "./numbers-email-claim-world";

export const retry = {
  /** Whether the provider takes an email to this address. */
  sendOk: (to: string): boolean => Boolean(to),
  mails: [] as string[],
  /** The idempotency key each email was sent under, in order. */
  keys: [] as (string | undefined)[],
  chat: "none" as "none" | "channel" | "throws",
  postOk: true,
  /** A post whose outcome the chat did not say (a timeout, an abort, a thrown error, a 5xx): it may have been shown. */
  postUnknown: false,
  posts: [] as string[],
  /**
   * A sender that keeps each idempotency key for a day, as SES's once-key and Resend's idempotency do: the first
   * email under a key is delivered but its answer is lost (false, as lib/email.ts answers an unknown outcome); a
   * repeat inside the day is not delivered again and is not confirmed either; a repeat after the day is delivered
   * again.
   */
  lostAnswer: false,
  /** The emails that reached their address, in order (a try is not a delivery). */
  delivered: [] as string[],
  spends: "none" as "none" | "throws",
  team: "members" as "members" | "throws",
};

export function resetRetry(): void {
  retry.sendOk = () => true;
  retry.mails.length = 0;
  retry.keys.length = 0;
  retry.chat = "none";
  retry.postOk = true;
  retry.postUnknown = false;
  retry.posts.length = 0;
  retry.lostAnswer = false;
  retry.delivered.length = 0;
  firstUnder.clear();
  retry.spends = "none";
  retry.team = "members";
}

const DAY_MS = 86_400_000;
const firstUnder = new Map<string, number>();

export async function sendEmail(message: { to: string; subject: string; idempotencyKey?: string }): Promise<boolean> {
  retry.mails.push(message.to);
  retry.keys.push(message.idempotencyKey);
  const key = message.idempotencyKey;
  if (retry.lostAnswer && key) {
    const first = firstUnder.get(key);
    if (first !== undefined && Date.now() - first < DAY_MS) return false;
    firstUnder.set(key, Date.now());
    retry.delivered.push(message.to);
    return first !== undefined;
  }
  if (!retry.sendOk(message.to)) return false;
  retry.delivered.push(message.to);
  return true;
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
export async function postToChat(url: string): Promise<"sent" | "refused" | "unknown"> {
  retry.posts.push(url);
  if (retry.postUnknown) return "unknown";
  return retry.postOk ? "sent" : "refused";
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
