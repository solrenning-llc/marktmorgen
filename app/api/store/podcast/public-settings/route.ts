import type { NextRequest } from "next/server";
import { type Store, storeForEmail } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { guardStoreWrite, text } from "@/lib/store-request";
import { type Listing, readListingExactly } from "@/lib/catalog";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readPodcast } from "@/lib/podcast";
import { EPISODE_ID } from "@/lib/podcast-rules";
import { PUBLIC_CATEGORIES, type PublicCategory } from "@/lib/podcast-public-feed";
import { type PublicShowSettings, audioRefusal, dropPublicShow, readPublicShow, settingsOf, writePublicShow } from "@/lib/podcast-public-show";
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

function answer(store: Store, product: Listing, settings: PublicShowSettings | null): Response {
  const feed: Feed = {
    on: settings !== null,
    category: settings?.category ?? null,
    explicit: settings?.explicit ?? null,
    episodes: settings?.episodes ?? {},
    address: `${SITE_URL}/api/store/podcast/public/${store.handle}/${product.id}.xml`,
  };
  return Response.json({ ok: true, feed });
}

/** What a full data room says, or a record too large to be one. */
function refused(write: { reason: "full" | "too_big"; message?: string }): Response {
  return Response.json({ ok: false, error: write.reason, ...(write.message ? { message: write.message } : {}) }, { status: 409 });
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
      const show = await readPublicShow(podcastId);
      const settings = show ? settingsOf(show) : null;
      if (show && !settings) return fail("unavailable", 503);
      return answer(store, product, settings);
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

    return await withLock(`nl:pod:${podcastId}:lock`, 60, 15_000, async () => {
      // Read again under the lock: a product removed, turned into another podcast or made a draft while this waited
      // is not written for.
      const now = store.sid ? await storeForIdExactly(store.sid) : "unknown";
      if (now === "unknown") return fail("unavailable", 503);
      if (now === "none") return fail("none", 404);
      const still = await readListingExactly(now, id);
      if (still === "unknown") return fail("unavailable", 503);
      if (!still || still.podcast?.id !== podcastId) return fail("unknown", 404);
      const show = await readPublicShow(podcastId);
      const current = show ? settingsOf(show) : null;
      if (show && !current) throw new UnknownReplyError("a podcast's public settings");

      if (action === "off") {
        if (show) await dropPublicShow(now, podcastId);
        return answer(now, still, null);
      }
      if (still.hidden) return fail("private", 409);
      const podcast = await readPodcast(podcastId);
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
        if (JSON.stringify(next.episodes) === JSON.stringify(current.episodes)) return answer(now, still, current);
      }
      const written = await writePublicShow(now, podcastId, next, show);
      if (!written.ok) return refused(written);
      return answer(now, still, next);
    });
  } catch (error) {
    if (error instanceof LockBusyError) return fail("busy", 409);
    if (!(error instanceof UnknownReplyError)) console.error("changing a podcast's public feed failed", error);
    return fail("unavailable", 503);
  }
}
