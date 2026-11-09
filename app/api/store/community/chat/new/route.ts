import type { NextRequest } from "next/server";
import { withAliases } from "@/lib/community-alias";
import { shareFor } from "@/lib/chat-pace";
import { passFits } from "@/lib/chat-pass";
import { room } from "@/lib/community-chat";
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
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: NOT_KEPT });
  try {
    const page = await room(id, since);
    return Response.json(
      // Each author by their alias, never their key (lib/community-alias.ts, audit N2).
      { ok: true, messages: withAliases(id, page.messages), cursor: page.cursor },
      { headers: { "Cache-Control": `public, max-age=0, s-maxage=${shareFor(pace)}` } },
    );
  } catch (error) {
    console.error("reading what is new in a room failed", error);
    return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: NOT_KEPT });
  }
}
