import type { NextRequest } from "next/server";
import { fromAnotherSite, refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import { lockRead } from "@/lib/two-step-unknown";
import { limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { CREATOR, readMembers, within } from "@/lib/community";
import { communityViewer } from "@/lib/community-access";
import { MAX_CHAT_TEXT, clearRoom, lastSaid, room, say, unsay } from "@/lib/community-chat";
import { wholeUnits } from "@/lib/community-chat-rules";
import { grantRoom } from "@/lib/chat-grant";
import { isTalking } from "@/lib/chat-pace";
import { takeBuyerAction } from "@/lib/buyer-actions";

/** What the page shows for a reason it does not know, or "unknown": the room's honest "could not confirm" sentence. */
const unconfirmed = () => Response.json({ ok: false, error: "unknown" }, { status: 503, headers: { "Cache-Control": "no-store" } });

/**
 * The room: reading what is new, and saying something.
 *
 * JSON both ways. This is the route that knows who is asking, and so it is
 * not the one a page asks every few seconds: that is the shared one beside
 * it (new/route.ts), opened by a pass. A page comes here for the pass, ten
 * minutes at a time (`grant=live` or `grant=idle`, lib/chat-grant.ts), and
 * is brought what came after `since` while it is here. A room whose store
 * has no leave to give is read from here too, when its reader asks.
 *
 * Every rule is decided here and not on the page: whether the room exists,
 * whether this person may write in it, the cooldown between messages, and
 * whether a web address may be written. A page that hides its box is a
 * courtesy; this is the door.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const handle = normaliseHandle((url.searchParams.get("handle") ?? "").trim().slice(0, 60));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !store.community) return Response.json({ ok: false, error: "none" }, { status: 404 });
  const viewer = await communityViewer(store, request.cookies);
  if (viewer.state !== "in") return Response.json({ ok: false, error: "out" }, { status: 403 });
  if (!viewer.config.chat.on) return Response.json({ ok: false, error: "off" }, { status: 404 });

  const id = store.community.id;
  const askedRaw = Number(url.searchParams.get("since"));
  const since = Number.isInteger(askedRaw) && askedRaw > 0 ? askedRaw : 0;
  const page = await room(id, since);
  // The names, so the page never has to ask separately and never sees an
  // address. A member who chose no name is "A member", as everywhere else.
  // Messages said since October 7, 2026 carry theirs and need nothing read.
  const unnamed = page.messages.filter((m) => !m.n && m.a !== CREATOR).map((m) => m.a);
  const members = unnamed.length ? await readMembers(id, unnamed) : new Map<string, { n?: string }>();
  const names: Record<string, string> = {};
  for (const message of page.messages) {
    names[message.a] = message.a === CREATOR ? store.name : message.n || members.get(message.a)?.n || "A member";
  }
  // Leave to ask the shared route for the next ten minutes, when asked for.
  const want = url.searchParams.get("grant");
  let given: Awaited<ReturnType<typeof grantRoom>> = null;
  if (want === "live" || want === "idle") {
    // The pace of a talking room is given only while the room is talking.
    const newest = page.messages.length ? page.messages[page.messages.length - 1].at : want === "live" ? await lastSaid(id) : 0;
    const talking = newest > 0 && isTalking(Date.now() - newest * 1000);
    given = await grantRoom(store, id, { key: viewer.key, owner: viewer.owner }, want === "live", talking);
  }
  return Response.json(
    { ok: true, messages: page.messages, cursor: page.cursor, names, grant: given === "resting" ? null : given, resting: given === "resting" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  try {
    return await act(request);
  } catch (error) {
    // Redis did not answer, or answered a count in a shape nobody knows
    // (CX-123 rule 24): whether the message went in is not known, so the
    // page says it could not be confirmed, in the store's language, and asks
    // to check the room before sending again (refusals.unknown).
    console.error("a community room action failed", error);
    return unconfirmed();
  }
}

async function act(request: NextRequest): Promise<Response> {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  // Read only as far as 8_000 bytes, whether or not a length was declared (docs/security-audit-2026-10-18.md, MM-SA-10).
  const body = (await limited(request, 8_000).then((r) => r.json()).catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ ok: false, error: "bad" }, { status: 400 });
  // A lone half of a surrogate pair is made U+FFFD (wholeUnits): JSON sends
  // it escaped in 6 bytes, and a look at the room is priced at 3 a unit
  // (lib/chat-pace.ts, LOOK_MOST_BYTES). Done after the cut, which can
  // split a pair.
  const text = (value: unknown, max: number) => (typeof value === "string" ? wholeUnits(value.trim().slice(0, max)) : "");

  const handle = normaliseHandle(text(body.handle, 60));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !store.community) return Response.json({ ok: false, error: "none" }, { status: 404 });
  const viewer = await communityViewer(store, request.cookies);
  if (viewer.state !== "in") return Response.json({ ok: false, error: "out" }, { status: 403 });
  const { config, owner, key } = viewer;
  if (!config.chat.on) return Response.json({ ok: false, error: "off" }, { status: 404 });
  const id = store.community.id;
  const action = text(body.action, 20);
  // One of the store's buyer actions, or the creator's studio requests, before anything is written (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store, owner ? "owner" : "buyer"))) return Response.json({ ok: false, error: "resting" }, { status: 503 });

  if (action === "say") {
    // Muted means reads, does not write — here exactly as everywhere else,
    // with nothing extra for a member to learn.
    if (!owner && !viewer.canWrite) {
      return Response.json({ ok: false, error: viewer.member?.muted ? "muted" : "full" }, { status: 403 });
    }
    if (!owner && !viewer.member?.n) return Response.json({ ok: false, error: "name" }, { status: 403 });
    // The hourly ceiling on top of the cooldown: one stops a flood in a
    // minute, the other stops one over an afternoon.
    if (!owner && !(await within(id, key, "comment"))) {
      // "hourly", not "slow": the ceiling over an afternoon is a different
      // thing from the wait between two messages, and telling somebody they
      // are waiting thirty seconds when they are waiting an hour is a lie the
      // room used to tell.
      return Response.json({ ok: false, error: "hourly" }, { status: 429 });
    }
    const name = wholeUnits(owner ? store.name : viewer.member?.n || "A member");
    const said = await say(id, config.chat, key, owner, text(body.text, MAX_CHAT_TEXT), name);
    if (!said.ok) {
      return Response.json({ ok: false, error: said.reason, wait: said.wait }, { status: said.reason === "slow" ? 429 : said.reason === "unknown" ? 503 : 400 });
    }
    return Response.json({ ok: true, message: said.message, name });
  }

  // Taking something out, and emptying the room: the creator's alone.
  if (!owner) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  // Neither comes back: a session let in without its second step waits (lib/two-step.ts).
  const lock = await lockRead(lockedFor(request, "community", action));
  if (lock instanceof Response) return lock;
  if (lock) return refusedJson("locked");
  if (action === "unsay") {
    const number = Number(body.number);
    if (!Number.isInteger(number) || number <= 0) return Response.json({ ok: false, error: "bad" }, { status: 400 });
    return Response.json({ ok: await unsay(id, number) });
  }
  if (action === "clear") {
    await clearRoom(id);
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false, error: "unknown" }, { status: 400 });
}
