/**
 * What the chat room says to a screen reader when messages arrive (WCAG 2.2 4.1.3, components/community-room.tsx):
 * how many came from other people, once per batch, never the messages themselves, so a busy room does not flood
 * the reader. One's own message is never counted. Kept apart from the component so it is tested without a browser.
 */
export function newFromOthers(found: { a: string }[], me: string): number {
  return found.filter((m) => m.a !== me).length;
}

/** The sentence for `count` new messages, in the room's words; nothing for none. */
export function roomNews(count: number, words: { newOne: string; newMany: string }): string {
  if (count <= 0) return "";
  return count === 1 ? words.newOne : words.newMany.replace("{n}", String(count));
}
