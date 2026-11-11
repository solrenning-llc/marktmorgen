/**
 * A podcast record read in an unknown shape is never taken for an empty podcast (CX-123 rule 24; sweep APP3, finding 2).
 *
 * app/api/store/podcast/route.ts read `(await readPodcast(id)) ?? { id, episodes: [] }`, and readPodcast answered null
 * both for a podcast with no record and for a GET of nl:pod:<id> that came back with no reply, a number or text that is
 * not a podcast. Under the lock the route then wrote the podcast back whole: an upload left the private feed with only
 * the new episode, and "disable" deleted a podcast that had episodes. Now readPodcast answers null only for Redis's
 * exact null and throws UnknownReplyError for anything else, and the route answers 503 "unavailable" and writes nothing.
 *
 * Synthetic only: the in-memory Redis double, and a local stand-in for Vercel Blob's HEAD answering for the upload.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setPodcastEpisodes, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import { MAX_EPISODES, type Podcast } from "@/lib/podcast-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_podroute_notarealsecret";

// Vercel Blob's HEAD (GET ?url=<pathname>, through undici's own fetch), answered by a local stand-in for any file.
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const blobStandIn = createServer((request, response) => {
  const asked = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("url") ?? "";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ url: `https://x.public.blob.vercel-storage.com/${asked}`, downloadUrl: `https://x.public.blob.vercel-storage.com/${asked}?download=1`, pathname: asked, size: 1234, contentType: "audio/mpeg", contentDisposition: "inline", cacheControl: "public", uploadedAt: new Date().toISOString(), etag: "\"e\"" }));
});

const OWNER = "podcast.route@example.com";
const ORIGIN = "https://marktmorgen.com";
const original = redis.pipeline.bind(redis);

const post = (session: string, body: unknown) =>
  podcastRoute(new NextRequest(`${ORIGIN}/api/store/podcast`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

/** A bent reply: built from the podcast's id and, when it needs it, the double's own reply to the same GET. */
type Bent = (podcastId: string, stored: () => Promise<unknown>) => unknown;

/** Only the next GET of nl:pod:<id> answers `reply`; everything else is the double's own. */
function bendPodcastGet(podcastId: string, reply: Bent) {
  let bent = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!bent && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:pod:${podcastId}`) {
      bent = true;
      return reply(podcastId, () => original(commands));
    }
    return original(commands);
  }) as typeof redis.pipeline;
}

function twoEpisodes(podcastId: string, folder: string, productId: string): Podcast {
  let podcast: Podcast = { id: podcastId, episodes: [] };
  for (const [n, title] of [["one", "Episode one"], ["two", "Episode two"]]) {
    const made = editPodcast(podcast, { op: "add", pathname: `stores/${folder}/${productId}/${n}.mp3`, bytes: 10, contentType: "audio/mpeg", title, notes: "", at: 1 });
    if (!made.ok) throw new Error("no episode");
    podcast = made.podcast;
  }
  return podcast;
}

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

/** The stored record as the double holds it, so a bent reply can change one part of it and keep the rest. */
async function storedRecord(stored: () => Promise<unknown>): Promise<{ id: string; episodes: Record<string, unknown>[] }> {
  const [raw] = (await stored()) as [string];
  return JSON.parse(raw) as { id: string; episodes: Record<string, unknown>[] };
}

const UNKNOWN: [string, Bent][] = [
  ["no reply", () => []],
  ["two replies", () => [null, null]],
  ["not a list", () => ({ 0: null })],
  ["a number", () => [7]],
  ["unparseable text", () => ["{\"id\":"]],
  ["JSON that is not a podcast", () => ["{\"id\":\"not a podcast id\"}"]],
  ["a Proxy", () => new Proxy([null], {})],
  // This podcast's own id, but episodes that cannot all be read: written back, the unread ones would leave the feed
  // (independent review on #2982, comment 6698656097).
  ["this podcast with no episodes list", (id) => [JSON.stringify({ id })]],
  ["this podcast with episodes that are not a list", (id) => [JSON.stringify({ id, episodes: { a: 1 } })]],
  ["this podcast with its episodes as JSON text", async (_id, stored) => {
    const record = await storedRecord(stored);
    return [JSON.stringify({ id: record.id, episodes: JSON.stringify(record.episodes) })];
  }],
  ["this podcast with one episode that does not parse", async (_id, stored) => {
    const record = await storedRecord(stored);
    delete record.episodes[1].pathname;
    return [JSON.stringify(record)];
  }],
  ["this podcast with more episodes than MAX_EPISODES", async (_id, stored) => {
    const record = await storedRecord(stored);
    const more = Array.from({ length: MAX_EPISODES + 1 - record.episodes.length }, (_, n) => ({ ...record.episodes[0], id: `x${String(n).padStart(11, "0")}` }));
    return [JSON.stringify({ id: record.id, episodes: [...record.episodes, ...more] })];
  }],
];

async function main(): Promise<void> {
  await new Promise<void>((resolve) => blobStandIn.listen(0, "127.0.0.1", resolve));
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(blobStandIn.address() as AddressInfo).port}`;
  redis.clear();
  await claimHandle(OWNER, "podroute", "Pod Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const folder = await storeFolder(OWNER);

  const setUp = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "9", null);
    if (!made.ok) throw new Error("no product");
    const pid = made.product.id;
    const podcastId = ((await (await post(session, { action: "enable", id: pid })).json()) as { podcastId: string }).podcastId;
    await savePodcast(twoEpisodes(podcastId, folder, pid));
    await setPodcastEpisodes(OWNER, pid, 2);
    const listed = await readListing((await storeForEmail(OWNER))!, pid);
    if (!listed?.podcast) throw new Error("not a podcast");
    return { pid, podcastId };
  };
  const titles = async (podcastId: string) => (await readPodcast(podcastId))?.episodes.map((e) => e.title).sort() ?? null;
  const podcastOf = async (pid: string) => (await readListing((await storeForEmail(OWNER))!, pid))?.podcast ?? null;

  part("readPodcast: null only for Redis's exact null, a podcast for its exact record");
  {
    is("a podcast with no record reads as null", await readPodcast("0123456789abcdef0123456789abcdef"), null);
    const redisEnv = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"] as const;
    const savedRedisEnv = redisEnv.map((name) => process.env[name]);
    for (const name of redisEnv) delete process.env[name];
    try {
      is("unconfigured Redis is unknown, not a missing podcast", await thrown(() => readPodcast("0123456789abcdef0123456789abcdef")), "UnknownReplyError");
    } finally {
      redisEnv.forEach((name, index) => { const value = savedRedisEnv[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    }
    const { podcastId } = await setUp("Show R");
    is("a stored podcast reads whole", await titles(podcastId), ["Episode one", "Episode two"]);
    for (const [label, reply] of UNKNOWN) {
      bendPodcastGet(podcastId, reply);
      is(`${label}: readPodcast throws UnknownReplyError, never null`, await thrown(() => readPodcast(podcastId)), "UnknownReplyError");
      redis.pipeline = original;
    }
  }

  part("Healthy control: an upload joins the episodes the feed has, and an empty podcast can be turned off");
  {
    const { pid, podcastId } = await setUp("Show A");
    const added = await post(session, { action: "add", id: pid, pathname: `stores/${folder}/${pid}/three.mp3`, title: "Episode three", notes: "" });
    is("the upload is accepted", added.status, 200);
    is("the feed keeps one and two and adds three", await titles(podcastId), ["Episode one", "Episode three", "Episode two"]);
    is("the product counts three", (await podcastOf(pid))?.episodes, 3);
    const refused = await post(session, { action: "disable", id: pid });
    is("turning it off is refused while it has episodes", [refused.status, ((await refused.json()) as { error?: string }).error], [400, "not_empty"]);
    const { pid: emptyPid, podcastId: emptyId } = await setUp("Show E");
    await savePodcast({ id: emptyId, episodes: [] });
    await setPodcastEpisodes(OWNER, emptyPid, 0);
    const off = await post(session, { action: "disable", id: emptyPid });
    is("an empty podcast is turned off", off.status, 200);
    is("and the product is no longer a podcast", await podcastOf(emptyPid), null);
  }

  for (const [label, reply] of UNKNOWN) {
    part(`Unknown read (${label}): the route answers 503 "unavailable" and writes nothing`);
    {
      const { pid, podcastId } = await setUp(`Show B ${label}`);
      bendPodcastGet(podcastId, reply);
      const added = await post(session, { action: "add", id: pid, pathname: `stores/${folder}/${pid}/three.mp3`, title: "Episode three", notes: "" });
      redis.pipeline = original;
      is(`add (${label}): 503 unavailable`, [added.status, ((await added.json()) as { error?: string }).error], [503, "unavailable"]);
      is(`add (${label}): the feed still holds one and two, nothing else`, await titles(podcastId), ["Episode one", "Episode two"]);
      is(`add (${label}): the product still counts two`, (await podcastOf(pid))?.episodes, 2);
    }
    {
      const { pid, podcastId } = await setUp(`Show C ${label}`);
      bendPodcastGet(podcastId, reply);
      const off = await post(session, { action: "disable", id: pid });
      redis.pipeline = original;
      is(`disable (${label}): 503 unavailable`, [off.status, ((await off.json()) as { error?: string }).error], [503, "unavailable"]);
      is(`disable (${label}): the record keeps both episodes`, await titles(podcastId), ["Episode one", "Episode two"]);
      is(`disable (${label}): the product is still the podcast`, (await podcastOf(pid))?.id, podcastId);
    }
    {
      const { pid, podcastId } = await setUp(`Show D ${label}`);
      const episode = (await readPodcast(podcastId))!.episodes[0].id;
      bendPodcastGet(podcastId, reply);
      const edited = await post(session, { action: "edit", id: pid, episode, title: "Renamed", notes: "" });
      redis.pipeline = original;
      is(`edit (${label}): 503 unavailable`, [edited.status, ((await edited.json()) as { error?: string }).error], [503, "unavailable"]);
      is(`edit (${label}): the record is unchanged`, await titles(podcastId), ["Episode one", "Episode two"]);
    }
  }

  blobStandIn.close();
  done();
}

main();
