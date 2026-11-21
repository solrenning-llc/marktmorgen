/** Client-safe community chat limits and refusal types. No storage, search or server imports. */
export const MAX_CHAT_TEXT = 1_000;
/** How many messages the room keeps. Older ones fall off the end. */
export const MAX_CHAT_KEPT = 500;
/** How many one look can bring back. */
export const CHAT_PAGE = 100;
/** The longest cooldown a creator may set, in seconds. */
export const MAX_SLOW = 300;

export type ChatRefusal =
  | "off"
  | "empty"
  | "links"
  | "slow"
  | "hourly"
  | "creatorOnly"
  | "muted"
  | "full"
  | "name"
  | "out"
  | "resting"
  | "unknown";

/**
 * A text with every lone half of a surrogate pair made U+FFFD, as
 * lib/webhooks.ts cleanText does: JSON escapes a lone half in 6 bytes and
 * any other UTF-16 unit in at most 3, so what a look at the room sends
 * (lib/chat-pace.ts, LOOK_MOST_BYTES) is bounded by the units it carries.
 * Whole pairs and every other letter are kept as they are.
 */
export function wholeUnits(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}
