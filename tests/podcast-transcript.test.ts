/**
 * A transcript for each private podcast episode (274 [AX1] Part B.3, "transcripts"; WCAG 1.2.1, audio-only
 * content needs a text alternative; 586 [KB7], "a transcript per episode").
 *
 * Before: an episode was its audio, a title and notes of at most 4,000 characters, so a listener who is deaf or hard
 * of hearing, or who cannot play sound, had no way to follow it, and the studio said nothing about it.
 *
 * Now the creator uploads the episode's words as a plain text file, through the same upload door every sold file
 * already uses (the same size, storage and monthly upload room checks; no AI, no new provider). It is kept in the
 * product's own private folder, reaches the buyer through the same signed address and access checks as the episode's
 * audio, and the buyer's feed names it in the podcast:transcript tag that apps showing transcripts read. Its address
 * carries the buyer's own feed token, so it is never written into the episode's notes, which apps show and share as
 * text (owner's privacy decision, 07/11/2026). The studio counts the episodes without one.
 *
 * Rule 23, assertions changed on 07/11/2026: the feed's "line in the notes" checks, the "line in every store
 * language" check (feedTranscript is gone) and the studio's "linked in the episode's notes" sentence now assert the
 * opposite or the new words, because the visible "Transcript: <url>" line exposed the buyer's token.
 *
 * Synthetic only: the in-memory Redis double, a local stand-in for Vercel Blob (HEAD and DELETE), and the private
 * file store's own local signing with stand-in keys. No network, no email, no payment.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setPodcastEpisodes, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import * as rules from "@/lib/podcast-rules";
import { feedXml, parsePodcast, type Episode, type Podcast } from "@/lib/podcast-rules";
import { feedToken } from "@/lib/podcast-access";
import { vaultPath } from "@/lib/vault-rules";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { openLockedSession } from "@/lib/two-step";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { GET as feedRoute } from "@/app/api/store/podcast/feed/[token]/route";
import { GET as playRoute } from "@/app/api/store/podcast/play/[token]/[episode]/route";
import { PodcastEditor } from "@/components/podcast-editor";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_podtranscript_notarealsecret";
// The private file store's addresses are signed here, with stand-in keys: nothing is asked of it over the network.
process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
process.env.R2_ACCESS_KEY_ID = "a-stand-in-access-key-id";
process.env.R2_SECRET_ACCESS_KEY = "a-stand-in-secret-access-key-for-tests-only";
process.env.R2_BUCKET = "stand-in-bucket";

const T = rules as unknown as Record<string, unknown>;
const MAX = typeof T.MAX_TRANSCRIPT_BYTES === "number" ? T.MAX_TRANSCRIPT_BYTES : 1024 * 1024;

// Vercel Blob, answered locally: HEAD (GET ?url=) tells the size and type by the file's name; a delete is written down.
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const deleted: string[] = [];
const blobStandIn = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    if (request.method === "POST" && url.pathname.endsWith("/delete")) {
      try {
        for (const one of (JSON.parse(body) as { urls?: string[] }).urls ?? []) deleted.push(one.replace(/^https:\/\/[^/]+\//, ""));
      } catch {
        // nothing
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const asked = url.searchParams.get("url") ?? "";
    const contentType = asked.endsWith(".txt") ? "text/plain" : asked.endsWith(".html") ? "text/html" : "audio/mpeg";
    const size = asked.endsWith("big.txt") ? MAX + 1 : asked.endsWith(".txt") ? 4321 : 1234;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ url: `https://x.public.blob.vercel-storage.com/${asked}`, downloadUrl: `https://x.public.blob.vercel-storage.com/${asked}?download=1`, pathname: asked, size, contentType, contentDisposition: "inline", cacheControl: "public", uploadedAt: new Date().toISOString(), etag: "\"e\"" }));
  });
});

const OWNER = "podcast.transcript@example.com";
const ORIGIN = "https://marktmorgen.com";
const post = (session: string, body: unknown) =>
  podcastRoute(new NextRequest(`${ORIGIN}/api/store/podcast`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
const answer = async (response: Response) => ({ status: response.status, body: (await response.json()) as { ok: boolean; error?: string; podcast?: Podcast } });
/** An episode's transcript as kept, null for none; "absent" when the episode has no such field at all. */
const transcriptOf = (podcast: Podcast | null | undefined, id: string) => {
  const episode = podcast?.episodes.find((e) => e.id === id) as Record<string, unknown> | undefined;
  return episode && "transcript" in episode ? episode.transcript : "absent";
};

function oneEpisode(): Podcast {
  const made = editPodcast({ id: "b".repeat(32), episodes: [] }, { op: "add", pathname: "stores/f/p/one.mp3", bytes: 10, contentType: "audio/mpeg", title: "One", notes: "", at: 1 });
  if (!made.ok) throw new Error("no episode");
  return made.podcast;
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => blobStandIn.listen(0, "127.0.0.1", resolve));
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(blobStandIn.address() as AddressInfo).port}`;

  part("The rules: what a transcript is, and how a kept one is read");
  is("a transcript is a plain text file", [T.TRANSCRIPT_TYPE, T.TRANSCRIPT_ACCEPT], ["text/plain", ".txt"]);
  is("up to a megabyte: ten hours of speech is well under it", [MAX, T.MAX_TRANSCRIPT_LABEL], [1024 * 1024, "1 MB"]);
  const isType = typeof T.isTranscriptType === "function" ? (T.isTranscriptType as (type: string) => boolean) : () => false;
  is("plain text is taken, with or without its character set; nothing else is", ["text/plain", "text/plain; charset=utf-8", "TEXT/PLAIN", "text/html", "audio/mpeg", ""].map(isType), [true, true, true, false, false, false]);
  const fresh = oneEpisode();
  is("a new episode has no transcript yet", transcriptOf(fresh, fresh.episodes[0].id), null);
  const kept = JSON.stringify({ id: "c".repeat(32), episodes: [
    { id: "aaaaaaaaaaaa", title: "A", notes: "", pathname: "stores/f/p/a.mp3", bytes: 1, contentType: "audio/mpeg", at: 1, transcript: { pathname: "stores/f/p/a.txt", bytes: 99 } },
    { id: "bbbbbbbbbbbb", title: "B", notes: "", pathname: "stores/f/p/b.mp3", bytes: 1, contentType: "audio/mpeg", at: 2, transcript: { pathname: 7, bytes: "x" } },
    { id: "cccccccccccc", title: "C", notes: "", pathname: "stores/f/p/c.mp3", bytes: 1, contentType: "audio/mpeg", at: 3 },
  ] });
  const read = parsePodcast(kept);
  is("a kept transcript is read back", transcriptOf(read, "aaaaaaaaaaaa"), { pathname: "stores/f/p/a.txt", bytes: 99 });
  is("a malformed one is no transcript, and the episode stays", [transcriptOf(read, "bbbbbbbbbbbb"), read?.episodes.length], [null, 3]);
  is("an episode kept before transcripts existed has none", transcriptOf(read, "cccccccccccc"), null);
  const untranscribed = typeof T.untranscribed === "function" ? (T.untranscribed as (episodes: Episode[]) => number)(read?.episodes ?? []) : -1;
  is("the studio's count of episodes without one", untranscribed, 2);

  part("Changing an episode's transcript (editPodcast)");
  {
    let podcast = oneEpisode();
    const id = podcast.episodes[0].id;
    const edit = (change: { pathname: string | null; bytes: number; contentType: string }) => editPodcast(podcast, { op: "transcript", id, ...change });
    const wrong = edit({ pathname: "stores/f/p/t.html", bytes: 10, contentType: "text/html" });
    is("only plain text", wrong.ok ? "kept" : wrong.reason, "type");
    const big = edit({ pathname: "stores/f/p/big.txt", bytes: MAX + 1, contentType: "text/plain" });
    is("not over the size", big.ok ? "kept" : big.reason, "too_big");
    const lost = editPodcast(podcast, { op: "transcript", id: "zzzzzzzzzzzz", pathname: "stores/f/p/t.txt", bytes: 10, contentType: "text/plain" });
    is("not on an episode that is gone", lost.ok ? "kept" : lost.reason, "unknown");
    const added = edit({ pathname: "stores/f/p/t.txt", bytes: 10, contentType: "text/plain; charset=utf-8" });
    is("added, with nothing to delete", added.ok ? [transcriptOf(added.podcast, id), (added as { dropped?: unknown }).dropped] : added.reason, [{ pathname: "stores/f/p/t.txt", bytes: 10 }, []]);
    if (added.ok) podcast = added.podcast;
    const again = editPodcast(podcast, { op: "edit", id, title: "One, renamed", notes: "New notes" });
    is("changing the episode's words keeps its transcript", again.ok ? transcriptOf(again.podcast, id) : again.reason, { pathname: "stores/f/p/t.txt", bytes: 10 });
    const replaced = edit({ pathname: "stores/f/p/t2.txt", bytes: 20, contentType: "text/plain" });
    is("replaced: the old file is the one to delete", replaced.ok ? [transcriptOf(replaced.podcast, id), (replaced as { dropped?: unknown }).dropped] : replaced.reason, [{ pathname: "stores/f/p/t2.txt", bytes: 20 }, ["stores/f/p/t.txt"]]);
    if (replaced.ok) podcast = replaced.podcast;
    const removed = edit({ pathname: null, bytes: 0, contentType: "" });
    is("removed: none left, its file to delete", removed.ok ? [transcriptOf(removed.podcast, id), (removed as { dropped?: unknown }).dropped] : removed.reason, [null, ["stores/f/p/t2.txt"]]);
    const withOne = edit({ pathname: "stores/f/p/t3.txt", bytes: 5, contentType: "text/plain" });
    const gone = withOne.ok ? editPodcast(withOne.podcast, { op: "remove", id }) : withOne;
    is("deleting the episode deletes its audio and its transcript", gone.ok ? (gone as { dropped?: unknown }).dropped : gone.reason, ["stores/f/p/one.mp3", "stores/f/p/t3.txt"]);
    const bare = oneEpisode();
    const plain = editPodcast(bare, { op: "remove", id: bare.episodes[0].id });
    is("an episode without one: its audio only", plain.ok ? (plain as { dropped?: unknown }).dropped : plain.reason, ["stores/f/p/one.mp3"]);
  }

  part("The feed a buyer's app reads");
  {
    const podcast = parsePodcast(kept)!;
    // A feed that cannot be written reads as its error, so every check below still runs and says what it found.
    const feedOf = (input: Parameters<typeof feedXml>[0]) => {
      try {
        return feedXml(input);
      } catch (error) {
        return `threw: ${String(error)}`;
      }
    };
    const xml = feedOf({
      title: "Show", summary: "", author: "Shop", page: "https://x/p", image: null, episodes: podcast.episodes,
      audio: (e: Episode) => `https://x/play/${e.id}.mp3`,
      transcript: { url: (e: Episode) => `https://x/play/${e.id}.txt` },
    });
    const itemOf = (id: string) => xml.split("<item>").find((one) => one.includes(`<guid isPermaLink="false">${id}</guid>`)) ?? "";
    is("the podcast namespace is declared", xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"'), true);
    is("an episode with one names it for apps that show transcripts", itemOf("aaaaaaaaaaaa").includes('<podcast:transcript url="https://x/play/aaaaaaaaaaaa.txt" type="text/plain"/>'), true);
    // Rule 23: was "and in its notes, which every app shows" (true). The address carries the buyer's token.
    is("never in its notes, which apps show and share as text", [itemOf("aaaaaaaaaaaa").includes("<description></description>"), itemOf("aaaaaaaaaaaa").includes("Transcript:")], [true, false]);
    is("an episode without one names none", [itemOf("cccccccccccc").includes("podcast:transcript"), itemOf("cccccccccccc").includes("Transcript:")], [false, false]);
    const noted = feedOf({ title: "Show", summary: "", author: "Shop", page: "https://x/p", image: null, episodes: [{ ...podcast.episodes[0], notes: "Notes <here>" }], audio: (e: Episode) => `https://x/play/${e.id}.mp3`, transcript: { url: (e: Episode) => `https://x/play/${e.id}.txt` } });
    // Rule 23: was "after the episode's own notes, escaped" (the line after them). The notes are the creator's alone.
    is("the episode's own notes are left as they are, escaped", noted.includes("<description>Notes &lt;here&gt;</description>"), true);
    const words = COURSES_WORDS as unknown as Record<string, { feedTranscript?: unknown }>;
    // Rule 23: was "the line is in every store language". A line that only carries the address is not kept.
    is("no store language has a notes line for it", Object.entries(words).filter(([, w]) => "feedTranscript" in w).map(([code]) => code), []);
  }

  part("The studio's door: adding, replacing and removing a transcript");
  redis.clear();
  await claimHandle(OWNER, "podtext", "Pod Text", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Spoken Show", "", "9", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  const podcastId = ((await (await post(session, { action: "enable", id: pid })).json()) as { podcastId: string }).podcastId;
  const at = (name: string) => `stores/${folder}/${pid}/${name}`;
  const out = await answer(await post(session, { action: "add", id: pid, pathname: at("ep1.mp3"), title: "Episode one", notes: "" }));
  const episodeId = out.body.podcast?.episodes[0]?.id ?? "";
  is("an episode is out", [out.status, out.body.ok, episodeId.length], [200, true, 12]);
  const send = (change: Record<string, unknown>) => post(session, { action: "transcript", id: pid, episode: episodeId, ...change }).then(answer);
  is("a file outside the product's folder is refused", (await send({ pathname: `stores/${folder}/other/x.txt` })).body.error, "invalid");
  is("the episode's own audio is never its transcript", (await send({ pathname: at("ep1.mp3") })).body.error, "in_use");
  is("what the file is, is read from storage: a web page is refused", (await send({ pathname: at("page.html") })).body.error, "type");
  is("over the size is refused", (await send({ pathname: at("big.txt") })).body.error, "too_big");
  is("for an episode that is not there", (await post(session, { action: "transcript", id: pid, episode: "zzzzzzzzzzzz", pathname: at("x.txt") }).then(answer)).body.error, "unknown");
  is("nothing was kept or deleted for a refusal", [transcriptOf(await readPodcast(podcastId), episodeId), deleted], [null, []]);
  const first = await send({ pathname: at("words.txt") });
  is("a plain text file is kept, with its size from storage", [first.status, transcriptOf(first.body.podcast, episodeId), transcriptOf(await readPodcast(podcastId), episodeId)], [200, { pathname: at("words.txt"), bytes: 4321 }, { pathname: at("words.txt"), bytes: 4321 }]);
  // A session let in without the second step (lib/two-step.ts) may add a transcript, never delete one.
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);
  const asLocked = (change: Record<string, unknown>) => post(locked, { action: "transcript", id: pid, episode: episodeId, ...change }).then(answer);
  const lockedReplace = await asLocked({ pathname: at("other.txt") });
  const lockedRemove = await asLocked({ remove: true });
  is("a locked session may not replace or remove one: each deletes a file", [lockedReplace.status, lockedReplace.body.error, lockedRemove.status, lockedRemove.body.error], [403, "locked", 403, "locked"]);
  is("and the transcript and its file are still there", [transcriptOf(await readPodcast(podcastId), episodeId), deleted], [{ pathname: at("words.txt"), bytes: 4321 }, []]);
  const second = await send({ pathname: at("words2.txt") });
  is("replaced: the new one kept, the old file deleted", [transcriptOf(second.body.podcast, episodeId), deleted], [{ pathname: at("words2.txt"), bytes: 4321 }, [at("words.txt")]]);
  const episode2 = await answer(await post(session, { action: "add", id: pid, pathname: at("words2.txt"), title: "Episode two", notes: "" }));
  is("a transcript is never another episode's audio", episode2.body.error, "in_use");
  const off = await send({ remove: true });
  is("removed: none left, its file deleted", [off.status, transcriptOf(off.body.podcast, episodeId), deleted], [200, null, [at("words.txt"), at("words2.txt")]]);
  await send({ pathname: at("words3.txt") });
  deleted.length = 0;
  const removedEpisode = await answer(await post(session, { action: "remove", id: pid, episode: episodeId }));
  is("deleting the episode deletes its audio and its transcript", [removedEpisode.status, [...deleted].sort()], [200, [at("ep1.mp3"), at("words3.txt")].sort()]);

  part("The buyer's feed and the transcript's own address");
  {
    const textPath = vaultPath(folder, pid, "a1b2c3d4e5f60718", "episode-words.txt");
    const saved: Podcast = {
      id: podcastId,
      episodes: [
        { id: "aaaaaaaaaaaa", title: "Heard", notes: "", pathname: vaultPath(folder, pid, "a1b2c3d4e5f60719", "heard.mp3"), bytes: 100, contentType: "audio/mpeg", at: 10, transcript: { pathname: textPath, bytes: 321 } } as Episode,
        { id: "bbbbbbbbbbbb", title: "Unwritten", notes: "", pathname: vaultPath(folder, pid, "a1b2c3d4e5f60720", "unwritten.mp3"), bytes: 100, contentType: "audio/mpeg", at: 20 } as Episode,
      ],
    };
    await savePodcast(saved);
    await setPodcastEpisodes(OWNER, pid, 2);
    const store = (await storeForEmail(OWNER))!;
    is("still a podcast", (await readListing(store, pid))?.podcast?.episodes, 2);
    const token = (await feedToken(store, pid, OWNER))!;
    const feed = await feedRoute(new Request(`${ORIGIN}/api/store/podcast/feed/${token}.xml`) as never, { params: Promise.resolve({ token: `${token}.xml` }) });
    const xml = await feed.text();
    const textUrl = `${ORIGIN}/api/store/podcast/play/${token}/aaaaaaaaaaaa.txt`;
    // Rule 23: the last value was true (the line in the notes). The tag stays; the notes never carry the token.
    is("the feed names the transcript by the buyer's own address, in its tag only", [feed.status, xml.includes(`<podcast:transcript url="${textUrl}" type="text/plain"/>`), xml.includes(`Transcript: ${textUrl}`)], [200, true, false]);
    const descriptions = xml.match(/<description>[\s\S]*?<\/description>/g) ?? [];
    is("no description in the feed carries the buyer's token", [descriptions.length > 0, descriptions.some((d) => d.includes(token))], [true, false]);
    is("and none for the episode without one", xml.includes("bbbbbbbbbbbb.txt"), false);
    const play = (episode: string) => playRoute(new Request(`${ORIGIN}/api/store/podcast/play/${token}/${episode}`) as never, { params: Promise.resolve({ token, episode }) });
    const opened = await play("aaaaaaaaaaaa.txt");
    const location = opened.headers.get("location") ?? "";
    is("the transcript opens at a signed address of its own file, for a few hours, kept by nobody", [opened.status, location.includes("episode-words.txt"), location.includes("X-Amz-Signature"), opened.headers.get("cache-control")], [302, true, true, "private, no-store"]);
    is("an episode without one: not found", (await play("bbbbbbbbbbbb.txt")).status, 404);
    const audio = await play("aaaaaaaaaaaa.mp3");
    is("the audio still opens as before", [audio.status, (audio.headers.get("location") ?? "").includes("heard.mp3")], [302, true]);
    const stranger = (await feedToken(store, pid, "stranger@example.com"))!;
    const refused = await playRoute(new Request(`${ORIGIN}/api/store/podcast/play/${stranger}/aaaaaaaaaaaa.txt`) as never, { params: Promise.resolve({ token: stranger, episode: "aaaaaaaaaaaa.txt" }) });
    is("someone who does not hold the podcast never gets it", refused.status, 403);
  }

  part("The studio: each episode says whether it has a transcript, and the missing ones are counted");
  {
    const show: Podcast = {
      id: "d".repeat(32),
      episodes: [
        { id: "aaaaaaaaaaaa", title: "With words", notes: "", pathname: "stores/f/p/a.mp3", bytes: 1, contentType: "audio/mpeg", at: 1, transcript: { pathname: "stores/f/p/a.txt", bytes: 2048 } } as Episode,
        { id: "bbbbbbbbbbbb", title: "Without", notes: "", pathname: "stores/f/p/b.mp3", bytes: 1, contentType: "audio/mpeg", at: 2, transcript: null } as Episode,
        { id: "cccccccccccc", title: "Also without", notes: "", pathname: "stores/f/p/c.mp3", bytes: 1, contentType: "audio/mpeg", at: 3, transcript: null } as Episode,
      ],
    };
    const html = renderToStaticMarkup(createElement(PodcastEditor, { productId: "p", folder: "f", initial: show }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    is("the missing ones are counted, with why they matter", [/2 episodes have no transcript/.test(text), /deaf or hard of hearing/.test(text), /cannot play sound/.test(text)], [true, true, true]);
    // Rule 23: was "linked in the episode's notes in each listener's podcast app" (no longer true).
    is("and where listeners find it, honestly", [/podcast apps that show transcripts/i.test(text), /in the episode['’]s notes/.test(text)], [true, false]);
    is("each episode says so", [(text.match(/No transcript yet/g) ?? []).length, /Transcript added \(2 KB\)/.test(text)], [2, true]);
    is("a file field for it, plain text only, with a visible name", [(html.match(/accept="\.txt"/g) ?? []).length >= 3, /Add a transcript/.test(text), /Replace the transcript/.test(text), /Remove the transcript/.test(text)], [true, true, true, true]);
    is("the new episode form takes one too, optional", /Transcript \(optional\)/.test(text), true);
    is("the size the studio says is the size the server holds a file to", /up to 1 MB/.test(text), true);
    const all: Podcast = { ...show, episodes: show.episodes.slice(0, 1) };
    const quiet = renderToStaticMarkup(createElement(PodcastEditor, { productId: "p", folder: "f", initial: all })).replace(/<[^>]+>/g, " ");
    is("no count when every episode has one", /have no transcript|has no transcript/.test(quiet), false);
    const one: Podcast = { ...show, episodes: show.episodes.slice(0, 2) };
    is("one, said as one", /1 episode has no transcript/.test(renderToStaticMarkup(createElement(PodcastEditor, { productId: "p", folder: "f", initial: one })).replace(/<[^>]+>/g, " ")), true);
    const words = text.toLowerCase();
    is("no claim of conformity or law", [/fully accessible|ada compliant|wcag|certified|required by law|the law/.test(words)], [false]);
  }

  part("Closing a store's plan deletes the transcripts with the audio");
  const closing = readFileSync(join(process.cwd(), "lib/plan-closing.ts"), "utf8");
  is("every file an episode drops is deleted, not only its audio", [/gone\.push\(\.\.\.edited\.dropped\)/.test(closing), /gone\.push\(episode\.pathname\)/.test(closing)], [true, false]);

  blobStandIn.close();
  done();
}

void main();
