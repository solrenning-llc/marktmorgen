import type { NextRequest } from "next/server";
import { type Store, storeForEmail } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { guardStoreWrite, text } from "@/lib/store-request";
import { type Listing, readListingExactly } from "@/lib/catalog";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readPodcastSized } from "@/lib/podcast";
import { EPISODE_ID } from "@/lib/podcast-rules";
import { PUBLIC_CATEGORIES, type PublicCategory } from "@/lib/podcast-public-feed";
import { PODCAST_RECORD_MOST, PUBLIC_SHOW_MAX_BYTES, type PublicShowSettings, audioRefusal, dropPublicShow, readPublicShowSized, settingsOf, writePublicShow } from "@/lib/podcast-public-show";
import { IncludedBytes, PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { holdStudio, refusedJson } from "@/lib/studio-route";
import { SITE_URL } from "@/lib/site-url";

/**
 * The studio's control for a podcast's public feed (33 [F2], part 3): the settings the public feed of part 2 is
 * written from (nl:pod:<id>:public, lib/podcast-public-show.ts).
 *
 *   { action: "read", id }                                    what it is now
 *   { action: "on", id, category, explicit, understood }     turns the feed on (or changes its category and flag)
 *   { action: "off", id }                                     turns it off: the record is deleted (never from a
 *                                                             session let in without its second step)
 *   { action: "episode", id, episode, public, audio }         puts one episode in the feed, or takes it out
 *
 * Nothing is public by itself. Turning the feed on needs `understood` exactly true (the studio shows that the feed is
 * public before it is pressed), a category and an explicit flag, and puts no episode in it: an episode of a paid
 * podcast belongs to its buyers until the creator marks it, one at a time, with an https address of their own for its
 * audio, never one of ours and never one that holds a buyer's token or address (audioRefusal). A draft product never
 * gets a public feed. Every change is made under the podcast's own lock, with the product read again under it, so no
 * settings are written for a podcast whose product went while this waited. Only an exact "OK" is a write and only 0
 * or 1 a deletion; anything not known is a 503 and is never said to be done (rule 24).
 */
const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

type Feed = { on: boolean; category: PublicCategory | null; explicit: boolean | null; episodes: Record<string, string>; address: string };

/** Bytes a request has moved so far: read from Redis, written to it and sent to the browser. */
type Moved = { bytes: number };

function answer(store: Store, product: Listing, settings: PublicShowSettings | null, moved: Moved): Response {
  const feed: Feed = {
    on: settings !== null,
    category: settings?.category ?? null,
    explicit: settings?.explicit ?? null,
    episodes: settings?.episodes ?? {},
    address: `${SITE_URL}/api/store/podcast/public/${store.handle}/${product.id}.xml`,
  };
  const body = JSON.stringify({ ok: true, feed });
  moved.bytes += Buffer.byteLength(body, "utf8");
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

/**
 * What one request may move at its worst (Claude 7's cost MEDIUM on #3544): the settings record read, written back
 * and sent (each at most PUBLIC_SHOW_MAX_BYTES) and, for a change, the podcast read (PODCAST_RECORD_MOST). The
 * studio requests for it are taken before anything is read, one each PAGE_INCLUDED_BYTES (what one studio request is
 * priced at, UNIT_COST.studio), on top of the guard's own; what the request did not move, measured from the bytes
 * Redis answered and the answer sent, is given back at its end. A request stopped part way gives nothing back.
 */
/**
 * What an answer adds to the record it sends, at the most: its fixed keys and the feed address, at the longest handle
 * (24 characters, lib/store-handle-pattern.ts) and product id (40); about 170 bytes, kept with room (Claude 5's LOW 3
 * on #3544: the answer could pass PUBLIC_SHOW_MAX_BYTES by these few dozen bytes).
 */
const ANSWER_EXTRA_BYTES = 512;
export const PUBLIC_SETTINGS_WORST_BYTES = {
  read: 2 * PUBLIC_SHOW_MAX_BYTES + ANSWER_EXTRA_BYTES,
  off: PUBLIC_SHOW_MAX_BYTES + ANSWER_EXTRA_BYTES,
  change: 3 * PUBLIC_SHOW_MAX_BYTES + PODCAST_RECORD_MOST + ANSWER_EXTRA_BYTES,
} as const;
/** Studio requests `bytes` costs beyond the request's own (lib/sent-bytes.ts, IncludedBytes). */
const unitsFor = (bytes: number) => new IncludedBytes().take(bytes, PAGE_INCLUDED_BYTES).units;

/** What a full data room says, or a record too large to be one. */
function refused(write: { reason: "full" | "too_big"; message?: string }): Response {
  return Response.json({ ok: false, error: write.reason, ...(write.message ? { message: write.message } : {}) }, { status: 409 });
}

/**
 * Runs `work` with the studio requests for `worstBytes` taken first, refused before anything is read when they are not
 * there; then gives back what was not moved. A busy lock gives back all of it (nothing was read); any other throw keeps
 * all it took (its measure is not trusted).
 */
async function paid(store: Store, worstBytes: number, work: (moved: Moved) => Promise<Response>): Promise<Response> {
  const most = unitsFor(worstBytes);
  const held = await holdStudio(store, most);
  if (!held.ok) return refusedJson("used", held.message);
  const moved: Moved = { bytes: 0 };
  // A busy lock throws before the work runs, so nothing was read: what was held is given back (Claude 6's LOW on
  // #3544). Anything else thrown keeps all it took, as its measure is not trusted.
  const response = await work(moved).catch(async (error: unknown) => {
    if (error instanceof LockBusyError) await held.give(most);
    throw error;
  });
  await held.give(most - unitsFor(moved.bytes));
  return response;
}

export async function POST(request: NextRequest) {
  // Turning the feed off deletes its record, with every episode's typed address: a session let in without its second
  // step may not (lib/two-step.ts, LOCKED_ACTIONS products "remove", as removing an episode); the rest stays open.
  const guarded = await guardStoreWrite(request, "products", 4_000, (sent) => (sent.action === "off" ? "remove" : ""));
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  if (!["read", "on", "off", "episode"].includes(action)) return fail("invalid");
  try {
    const store = await storeForEmail(ref);
    if (!store) return fail("none", 404);
    const product = await readListingExactly(store, id);
    if (product === "unknown") return fail("unavailable", 503);
    if (!product) return fail("unknown", 404);
    if (!product.podcast) return fail("not_podcast");
    const podcastId = product.podcast.id;

    if (action === "read") {
      return await paid(store, PUBLIC_SETTINGS_WORST_BYTES.read, async (moved) => {
        const { show, bytes } = await readPublicShowSized(podcastId);
        moved.bytes += bytes;
        const settings = show ? settingsOf(show) : null;
        if (show && !settings) return fail("unavailable", 503);
        return answer(store, product, settings, moved);
      });
    }

    // What was asked is checked before anything is locked or read.
    let category: PublicCategory | null = null;
    let explicit = false;
    let episode = "";
    let makePublic = false;
    let audio = "";
    if (action === "on") {
      if (body.understood !== true) return fail("understood");
      if (!(PUBLIC_CATEGORIES as readonly unknown[]).includes(body.category)) return fail("category");
      if (typeof body.explicit !== "boolean") return fail("explicit");
      category = body.category as PublicCategory;
      explicit = body.explicit;
    } else if (action === "episode") {
      episode = text(body.episode, 20);
      if (!EPISODE_ID.test(episode)) return fail("unknown", 404);
      if (typeof body.public !== "boolean") return fail("invalid");
      makePublic = body.public;
      if (makePublic) {
        const refusal = audioRefusal(body.audio);
        if (refusal) return fail(refusal);
        audio = body.audio as string;
      }
    }

    return await paid(store, action === "off" ? PUBLIC_SETTINGS_WORST_BYTES.off : PUBLIC_SETTINGS_WORST_BYTES.change, (moved) => withLock(`nl:pod:${podcastId}:lock`, 60, 15_000, async () => {
      // Read again under the lock: a product removed, turned into another podcast or made a draft while this waited
      // is not written for.
      const now = store.sid ? await storeForIdExactly(store.sid) : "unknown";
      if (now === "unknown") return fail("unavailable", 503);
      if (now === "none") return fail("none", 404);
      const still = await readListingExactly(now, id);
      if (still === "unknown") return fail("unavailable", 503);
      if (!still || still.podcast?.id !== podcastId) return fail("unknown", 404);
      const { show, bytes: showBytes } = await readPublicShowSized(podcastId);
      moved.bytes += showBytes;
      const current = show ? settingsOf(show) : null;
      if (show && !current) throw new UnknownReplyError("a podcast's public settings");

      if (action === "off") {
        if (show) await dropPublicShow(now, podcastId);
        return answer(now, still, null, moved);
      }
      // A hidden product gets no feed and no new public episode, but one can still be taken out (Claude 5's LOW 2 on
      // #3544): its public feed already answers 404 while the product is hidden.
      if (still.hidden && (action === "on" || makePublic)) return fail("private", 409);
      const { podcast, bytes: podcastBytes } = await readPodcastSized(podcastId);
      moved.bytes += podcastBytes;
      const episodes = new Set((podcast?.episodes ?? []).map((e) => e.id));
      // Only episodes the podcast still has stay in it: one deleted since is let go.
      const kept: Record<string, string> = {};
      for (const [episodeId, address] of Object.entries(current?.episodes ?? {})) if (episodes.has(episodeId)) kept[episodeId] = address;

      let next: PublicShowSettings;
      if (action === "on") {
        next = { category: category as PublicCategory, explicit, episodes: kept };
      } else {
        if (!current) return fail("off", 409);
        if (!episodes.has(episode)) return fail("unknown", 404);
        if (makePublic) kept[episode] = audio;
        else delete kept[episode];
        next = { ...current, episodes: kept };
        if (JSON.stringify(next.episodes) === JSON.stringify(current.episodes)) return answer(now, still, current, moved);
      }
      // Written at its full size: counted before the write, so a write that fails part way is paid for too.
      moved.bytes += Buffer.byteLength(JSON.stringify(next), "utf8");
      const written = await writePublicShow(now, podcastId, next, show);
      if (!written.ok) return refused(written);
      return answer(now, still, next, moved);
    }));
  } catch (error) {
    if (error instanceof LockBusyError) return fail("busy", 409);
    if (!(error instanceof UnknownReplyError)) console.error("changing a podcast's public feed failed", error);
    return fail("unavailable", 503);
  }
}
