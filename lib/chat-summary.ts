/**
 * The weekly and monthly numbers posted to a Slack or Discord channel (added
 * 11 October 2026), as Polar sends its summary to Slack and Baremetrics
 * posts to it: a team that lives in a chat sees the week where it already
 * looks, without anybody forwarding an email.
 *
 * The creator pastes an incoming webhook address made in their own Slack
 * (Apps, Incoming Webhooks) or Discord (Server settings, Integrations,
 * Webhooks). Only those two kinds of address are taken, so this can never be
 * pointed at anything else, and the address is sealed before it is kept
 * (lib/secret-box.ts), because whoever holds it can post to that channel. A
 * message is sent when it is saved, so a wrong address is said to be wrong at
 * once. What is posted is the same summary the email carries — totals,
 * channels, what is worth knowing — never a buyer's name or address.
 *
 * Kept by the store's statistics id, which stays with the store through a
 * change of address and is never handed to anybody else: kept by its handle,
 * a store that moved would stop posting without a word, and whoever later
 * claimed the old handle would have had their numbers posted to the first
 * store's channel.
 *
 *   nl:chatsum:<statsId>   sealed address
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { seal, unseal } from "@/lib/secret-box";

import { type ChatKind, chatKind } from "@/lib/chat-kind";

// The reading of an address lives in lib/chat-kind.ts, browser-safe, so the studio's field checks it the same way.
export { chatKind, type ChatKind };

const key = (statsId: string) => `nl:chatsum:${statsId}`;
const context = (statsId: string) => `chat-summary|${statsId}`;

/** What is posted, in the shape each takes: Slack's text with its three marks escaped, Discord's content under its 2,000 characters and with nobody pinged. */
export function chatBody(kind: ChatKind, text: string): Record<string, unknown> {
  if (kind === "slack") return { text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 3900) };
  return { content: text.length > 1990 ? `${text.slice(0, 1985)}…` : text, allowed_mentions: { parse: [] } };
}

/** Posts one message to an address; whether the chat took it. */
export async function postToChat(url: string, text: string): Promise<boolean> {
  const kind = chatKind(url);
  if (!kind) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody(kind, text)),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Which chat the store posts to, never the address. */
export async function chatSetup(statsId: string | null): Promise<ChatKind | null> {
  const url = await chatAddress(statsId);
  return url ? chatKind(url) : null;
}

/** The kept address, opened; null with none, or one that can no longer be read. */
export async function chatAddress(statsId: string | null): Promise<string | null> {
  if (!statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", key(statsId)]]);
  if (typeof raw !== "string" || !raw) return null;
  const opened = unseal(raw, context(statsId));
  return opened.ok && chatKind(opened.value) ? opened.value : null;
}

/**
 * Keeps an address, after a first message to it went through; or forgets it
 * (empty). "invalid" for an address of neither kind, "refused" when the chat
 * did not take the first message.
 */
export async function setChatAddress(statsId: string, storeName: string, raw: unknown): Promise<"saved" | "removed" | "invalid" | "refused"> {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url) {
    await redisPipeline([["DEL", key(statsId)]]);
    return "removed";
  }
  if (!chatKind(url)) return "invalid";
  const ok = await postToChat(url, `Marktmorgen will post ${storeName}'s numbers here: the week every Monday, and the month on the 1st.`);
  if (!ok) return "refused";
  await redisPipeline([["SET", key(statsId), seal(url, context(statsId))]]);
  return "saved";
}

/** A message from the email's text, without the email's own last lines about stopping it. */
export function forChat(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^You get this |^To stop |stop it: https?:\/\//.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
