/**
 * Which chat a webhook address belongs to (Slack or Discord), as the weekly
 * and monthly numbers are posted to it (lib/chat-summary.ts). Kept apart so
 * the studio's field can check an address by the very same reading when it
 * is left (487 [IT4], pattern 1; added 1 November 2026).
 *
 * Browser-safe: plain data and a pure function.
 */
export type ChatKind = "slack" | "discord";

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/;
const DISCORD = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;

/** Which chat an address belongs to, or null when it is neither. */
export function chatKind(raw: unknown): ChatKind | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  return SLACK.test(text) ? "slack" : DISCORD.test(text) ? "discord" : null;
}

/** The longest address either reading takes. */
export const MAX_CHAT_URL = 300;
