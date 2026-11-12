import type { NextRequest } from "next/server";
import { LOOK_BYTES, shareFor } from "@/lib/chat-pace";
import { wholeUnits } from "@/lib/community-chat-rules";
import { passFits } from "@/lib/chat-pass";
import { type ChatMessage, room } from "@/lib/community-chat";
import { COMMUNITY_ID } from "@/lib/community-text";
import { isRedisConfigured } from "@/lib/redis";

const NOT_KEPT = { "Cache-Control": "no-store" };

/**
 * What came into a room after message N.
 *
 * Asked every few seconds by every open room (lib/chat-pace.ts), so it is
 * made to cost next to nothing. It reads no cookie and knows nobody: it is
 * opened by the pass a member's page is handed (lib/chat-pass.ts), reads
 * the room once, and says the CDN may give everybody who asks the same
 * question the same answer for a few seconds. Readers of one room are all
 * at the same message, so a hundred of them are one read of the database
 * every few seconds and not a hundred.
 *
 * Each message carries the name it was said under, so nothing else is read.
 * A pass that no longer fits is answered 403, and the page goes back to the
 * route above this one, which knows who it is, for a new one.
 *
 * Only the address the room's page builds (components/community-room.tsx)
 * is answered: c, p and s in that order, s a whole number written plainly,
 * and i=1 or nothing. Any other spelling (an extra parameter, another
 * order, a percent-encoded letter, a leading zero) is the same question at
 * an address the CDN has not seen, so it is answered 400 before Redis is
 * asked, and spellings no longer open reads (R20 finding 1). A different
 * s is still a different address, though: one pass can still open one
 * read for each number it asks after, and that is not yet priced (part 2).
 *
 * A look sends at most LOOK_BYTES of messages, or one whole message when
 * that message alone is larger, and always at least the next one, so a
 * page never sticks. The worst is one message at its most,
 * LOOK_ONE_MESSAGE_BYTES (about 3.5 kB), and LOOK_MOST_BYTES is what a
 * look is priced at (lib/chat-pace.ts). Every lone half of a surrogate
 * pair is sent as U+FFFD (wholeUnits), so messages kept before the posting
 * route made them whole are bounded the same way. Its cursor is the last
 * message it sent: a page far behind is brought up to date over its next
 * looks instead of being sent a whole page of the room each time.
 *
 *   c   the community's id
 *   p   the pass
 *   s   the number of the last message the page has
 *   i   1 when the page is asking at the pace of a quiet room
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("c") ?? "").slice(0, 40);
  const pass = (url.searchParams.get("p") ?? "").slice(0, 40);
  const asked = Number(url.searchParams.get("s"));
  const since = Number.isInteger(asked) && asked > 0 ? asked : 0;
  const pace = url.searchParams.get("i") === "1" ? "idle" : "live";
  if (!COMMUNITY_ID.test(id)) return Response.json({ ok: false, error: "none" }, { status: 404, headers: NOT_KEPT });
  if (!passFits(id, pass)) return Response.json({ ok: false, error: "pass" }, { status: 403, headers: NOT_KEPT });
  if (url.search !== `?c=${id}&p=${pass}&s=${since}${pace === "idle" ? "&i=1" : ""}`) {
    return Response.json({ ok: false, error: "address" }, { status: 400, headers: NOT_KEPT });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: NOT_KEPT });
  try {
    const page = await room(id, since);
    const messages = withinLook(page.messages.map(whole), page.cursor);
    return Response.json(
      { ok: true, messages, cursor: messages.length ? messages[messages.length - 1].i : page.cursor },
      { headers: { "Cache-Control": `public, max-age=0, s-maxage=${shareFor(pace)}` } },
    );
  } catch (error) {
    console.error("reading what is new in a room failed", error);
    return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: NOT_KEPT });
  }
}

/** A message with every lone half of a surrogate pair in its texts made U+FFFD, as it is measured and sent. */
function whole(message: ChatMessage): ChatMessage {
  return { ...message, a: wholeUnits(message.a), text: wholeUnits(message.text), ...(message.n ? { n: wholeUnits(message.n) } : {}) };
}

/**
 * The first messages of a page that fit in LOOK_BYTES with the answer around
 * them, counted in the bytes they are sent as (the very objects the answer
 * serializes); always at least the first.
 * `cursor` is the largest the answer's cursor can be, so its digits are
 * counted at their most.
 */
function withinLook(messages: ChatMessage[], cursor: number): ChatMessage[] {
  let used = Buffer.byteLength(JSON.stringify({ ok: true, messages: [], cursor }));
  const kept: ChatMessage[] = [];
  for (const message of messages) {
    used += Buffer.byteLength(JSON.stringify(message)) + (kept.length ? 1 : 0);
    if (kept.length && used > LOOK_BYTES) break;
    kept.push(message);
  }
  return kept;
}
