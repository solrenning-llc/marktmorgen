/**
 * Leave for one member's page to ask a room what is new, ten minutes at a
 * time, and the count of it.
 *
 * lib/chat-pace.ts says why the room asks the way it does. This is where
 * each ten minutes of asking is handed out and counted toward the store's
 * visits (lib/traffic-rules.ts): ROOM_LIVE_PARTS hundredths of a visit for
 * ten minutes at the pace of a room that is talking, ROOM_IDLE_PARTS at the
 * pace of a quiet one. A page asks for the pace it needs, is told what it
 * got, and keeps to it.
 *
 *   - Counted once for a member's ten minutes, whatever they do in them: a
 *     page drawn again, a second tab, a phone and a laptop. A quiet leave
 *     that turns into a talking one is counted for the difference.
 *   - The pace of a talking room is given only while the room is talking.
 *     A page cannot ask its way into the dearer count.
 *   - The creator is never counted, as on every other page of their store.
 *   - At the finite counted-visit threshold, no new automatic polling grant
 *     is issued, including for paid plans. Existing grants can live until
 *     expiry; manual reads and owner activity have separate exposure.
 *
 *   nl:cm:<id>:rg:<member>   the leave a member holds: until when, and what it was counted as
 */
import { GRANT_MS } from "@/lib/chat-pace";
import { roomPass } from "@/lib/chat-pass";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { isResting, recordParts } from "@/lib/traffic";
import { ROOM_IDLE_PARTS, ROOM_LIVE_PARTS } from "@/lib/traffic-rules";

export type Grant = {
  /** What opens the room's shared answers (lib/chat-pass.ts). */
  pass: string;
  /** How much longer it lasts, in milliseconds. */
  ms: number;
  /** Whether it allows the pace of a room that is talking. */
  live: boolean;
};

const grantKey = (id: string, reader: string) => `nl:cm:${id}:rg:${reader}`;

/** A leave is not handed out again while it has more than this left. */
const FRESH_MS = 60_000;

type Held = { u: number; w: number };

function parseHeld(raw: unknown): Held | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Held>;
    return typeof v.u === "number" && typeof v.w === "number" ? { u: v.u, w: v.w } : null;
  } catch {
    return null;
  }
}

/**
 * Hands a member's page its leave, counting it. "resting" when the store
 * has none to give (at its finite visit threshold); null when it
 * could not be made or kept, and the page asks by name instead.
 *
 * `talking`: whether the room has been spoken in lately (lib/chat-pace.ts,
 * isTalking). `wantLive`: whether the page asked for the pace of a talking
 * room.
 */
export async function grantRoom(
  store: Store,
  id: string,
  reader: { key: string; owner: boolean },
  wantLive: boolean,
  talking: boolean,
  now = Date.now(),
): Promise<Grant | "resting" | null> {
  const pass = roomPass(id, now);
  if (!pass || !isRedisConfigured()) return null;
  const live = wantLive && talking;
  // The creator in their own room is never counted, and never refused.
  if (reader.owner) return { pass, ms: GRANT_MS, live };
  try {
    const weight = live ? ROOM_LIVE_PARTS : ROOM_IDLE_PARTS;
    const [raw] = await redisPipeline([["GET", grantKey(id, reader.key)]]);
    const held = parseHeld(raw);
    const left = held ? held.u - now : 0;
    if (held && left > FRESH_MS && held.w >= weight) return { pass, ms: left, live: held.w >= ROOM_LIVE_PARTS };
    if (await isResting(store, now, "buyer")) return "resting";
    const upgrade = held !== null && left > FRESH_MS;
    const until = upgrade ? held.u : now + GRANT_MS;
    const owed = upgrade ? weight - held.w : weight;
    await redisPipeline([["SET", grantKey(id, reader.key), JSON.stringify({ u: until, w: weight }), "EX", Math.max(1, Math.ceil((until - now) / 1000))]]);
    await recordParts(store, owed, now);
    return { pass, ms: until - now, live };
  } catch (error) {
    // A count that cannot be kept must not close a room: the page asks by
    // name instead, which is slower and is counted nowhere.
    console.error("a room's leave could not be handed out", error);
    return null;
  }
}

/** Deletes the leave one member holds in the room (lib/community-erasure.ts). */
export async function forgetGrantPerson(id: string, who: string): Promise<number> {
  if (!isRedisConfigured()) return 0;
  // Confirmed exactly (rule 24): an unknown reply is not "nothing to delete".
  const gone = countOf(repliesFor(await redisPipeline([["DEL", grantKey(id, who)]]), 1)?.[0]);
  if (gone === null) throw new UnknownReplyError("a member's room leave, deleted");
  return gone;
}
