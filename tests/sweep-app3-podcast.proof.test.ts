/**
 * Sweep APP3 proof (CX-123 rule 24), synthetic only. app/api/store/podcast/route.ts:44:
 *   const podcast = (await readPodcast(podcastId)) ?? { id: podcastId, episodes: [] };
 * readPodcast (lib/podcast.ts:31-35) answers null for a podcast with no record AND for a GET of nl:pod:<id> that came
 * back with no reply, a non-string or text that is not JSON (parsePodcast, lib/podcast-rules.ts:51-52). The route then
 * works on an empty podcast under the lock and writes it back whole:
 *   - "add" (the studio's normal upload of a new episode): savePodcast writes a record holding only the new episode,
 *     so every earlier episode leaves the private feed its paying listeners read, and setPodcastEpisodes writes 1 on
 *     the product; the earlier episodes' audio stays in the store's folder with nothing pointing at it.
 *   - "disable": the podcast is called empty, taken off the product and its record DELeted.
 * Nothing real is called: the in-memory Redis double, and a stand-in for Vercel Blob's HEAD answering for the upload.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { editPodcast, readPodcast, savePodcast } from "@/lib/podcast";
import type { Podcast } from "@/lib/podcast-rules";
import { POST as podcastRoute } from "@/app/api/store/podcast/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_sweepapp3_notarealsecret";

// Vercel Blob's HEAD (asked with GET ?url=<pathname>; the SDK uses undici's own fetch), answered by a local stand-in
// server for any file asked. Every other fetch is refused.
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
const blobStandIn = createServer((request, response) => {
  const asked = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("url") ?? "";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ url: `https://x.public.blob.vercel-storage.com/${asked}`, downloadUrl: `https://x.public.blob.vercel-storage.com/${asked}?download=1`, pathname: asked, size: 1234, contentType: "audio/mpeg", contentDisposition: "inline", cacheControl: "public", uploadedAt: new Date().toISOString(), etag: "\"e\"" }));
});

const OWNER = "podcast.app3@example.com";
const ORIGIN = "https://marktmorgen.com";
const original = redis.pipeline.bind(redis);

const post = (session: string, body: unknown) =>
  podcastRoute(new NextRequest(`${ORIGIN}/api/store/podcast`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));

/** Only the route's own read of the podcast record (one GET of nl:pod:<id>) answers `reply`; everything else is real. */
function bendPodcastGet(podcastId: string, reply: () => unknown[]) {
  let bent = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!bent && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:pod:${podcastId}`) {
      bent = true;
      return reply();
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

async function main(): Promise<void> {
  await new Promise<void>((resolve) => blobStandIn.listen(0, "127.0.0.1", resolve));
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(blobStandIn.address() as AddressInfo).port}`;
  redis.clear();
  await claimHandle(OWNER, "podapp3", "Pod Shop", "");
  await ensureStatsId(OWNER);
  const session = await openSession(OWNER);
  const folder = await storeFolder(OWNER);

  const setUp = async (title: string) => {
    const made = await addProduct(OWNER, title, "", "9", null);
    if (!made.ok) throw new Error("no product");
    const pid = made.product.id;
    const podcastId = ((await (await post(session, { action: "enable", id: pid })).json()) as { podcastId: string }).podcastId;
    await savePodcast(twoEpisodes(podcastId, folder, pid));
    return { pid, podcastId };
  };
  const titles = async (podcastId: string) => (await readPodcast(podcastId))?.episodes.map((e) => e.title) ?? null;
  const count = async (pid: string) => (await readListing((await storeForEmail(OWNER))!, pid))?.podcast?.episodes ?? null;

  part("Healthy control: a third episode is added beside the two the feed has");
  {
    const { pid, podcastId } = await setUp("Show A");
    const added = await post(session, { action: "add", id: pid, pathname: `stores/${folder}/${pid}/three.mp3`, title: "Episode three", notes: "" });
    is("the upload is accepted", added.status, 200);
    is("the feed keeps one and two and adds three", (await titles(podcastId))?.slice().sort(), ["Episode one", "Episode three", "Episode two"]);
    is("and the product counts three episodes", await count(pid), 3);
    const refused = await post(session, { action: "disable", id: pid });
    is("turning the podcast off is refused while it has episodes", [refused.status, ((await refused.json()) as { error?: string }).error], [400, "not_empty"]);
    is("and the feed is whole", (await titles(podcastId))?.length, 3);
  }

  for (const [label, reply] of [["no reply", () => []], ["a number", () => [7]], ["unparseable text", () => ["{\"id\":"]]] as const) {
    part(`DEFECT (${label}): the route's GET of the podcast record answers in an unknown shape`);
    {
      const { pid, podcastId } = await setUp(`Show B ${label}`);
      is("before: the feed has two episodes", (await titles(podcastId))?.length, 2);
      bendPodcastGet(podcastId, reply);
      const added = await post(session, { action: "add", id: pid, pathname: `stores/${folder}/${pid}/three.mp3`, title: "Episode three", notes: "" });
      redis.pipeline = original;
      is(`DEFECT (${label}): the upload is answered ok`, added.status, 200);
      is(`DEFECT (${label}): the feed now holds only the new episode; one and two are gone from it`, await titles(podcastId), ["Episode three"]);
      is(`DEFECT (${label}): the product says one episode`, await count(pid), 1);
    }
    {
      const { pid, podcastId } = await setUp(`Show C ${label}`);
      bendPodcastGet(podcastId, reply);
      const off = await post(session, { action: "disable", id: pid });
      redis.pipeline = original;
      is(`DEFECT (${label}): a podcast with two episodes is turned off as empty`, off.status, 200);
      is(`DEFECT (${label}): its record is deleted, with both episodes`, await readPodcast(podcastId), null);
      is(`DEFECT (${label}): and the product is no longer a podcast`, (await readListing((await storeForEmail(OWNER))!, pid))?.podcast ?? null, null);
    }
  }
  blobStandIn.close();
  done();
}

main();
