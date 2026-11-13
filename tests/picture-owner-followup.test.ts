/**
 * Three follow-ups to tests/picture-owner-paths.test.ts, from its independent security review (5 November 2026):
 *
 *   - a link that is not there answers "unknown" before any other refusal, and only a picture fresh from the door is
 *     deleted then: a picture of another product, link or page named for it is never touched. (Changed on Claude 5's
 *     correction on #2657: refusing before the door kept a fresh upload in storage for good, since the door's note
 *     ends in a day, nothing sweeps such pictures and the studio always uploads under a new name, so it is never
 *     chosen again.)
 *   - a product's file is never an episode's audio: the file route took an episode's audio (same product folder) as
 *     the product's file, and taking that file off (or replacing it) deleted the episode's audio. Today a podcast
 *     takes no file (lib/store.ts changeDelivery answers "course") and an option's file lives in the option's own
 *     folder, so no route reaches it; the check and the kept audio are a defence for a record written before those
 *     rules, seeded here directly;
 *   - the podcast editor's refusal says what is true in both cases the route refuses (another episode's audio or the
 *     product's own file), and the product editor has words for the file route's new refusal.
 *
 * Each check sends the real route a real request from the creator's own session, with synthetic files in a file
 * store held in memory (tests/failure-cleanup-world.ts), and reads what is left.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addOption, addProduct, addStoreLink, claimHandle, ensureStatsId, imageFolder, storeFolder, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fileFolder } from "@/lib/product-file";
import * as podcastStore from "@/lib/podcast";
import { dropPodcast, readPodcast } from "@/lib/podcast";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";
import { POST as productImage } from "@/app/api/store/image/route";
import { POST as door } from "@/app/api/store/image/upload/route";
import { POST as linkImage } from "@/app/api/store/link-image/route";
import { POST as links } from "@/app/api/store/links/route";
import { POST as fileAttach } from "@/app/api/store/file/attach/route";
import { POST as podcast } from "@/app/api/store/podcast/route";

const OWNER = "owner.followup@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);

const post = (path: string, session: string, body: unknown) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const result = async (response: Response) => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "ok"];

/**
 * Writes `file` onto product `id` wherever the store keeps it (its own record, the store's catalog head or an inline
 * catalog), as a record written before today's rules could have it. No route can write it: a podcast takes no file.
 */
function seedFile(id: string, file: Record<string, unknown>): number {
  let patched = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) next[key] = walk(inner);
    if (next.id === id && "podcast" in next && "file" in next) {
      next.file = file;
      patched += 1;
    }
    return next;
  };
  for (const key of redis.keys()) {
    if (redis.run(["TYPE", key]) !== "string") continue;
    const raw = redis.run(["GET", key]);
    if (typeof raw !== "string" || !raw.includes(id)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const before = patched;
    const next = walk(parsed);
    if (patched > before) redis.run(["SET", key, JSON.stringify(next)]);
  }
  return patched;
}

async function main(): Promise<void> {
  redis.clear();
  files.clear();
  await claimHandle(OWNER, "ownerfollowup", "Owner Followup", "");
  await ensureStatsId(OWNER);
  const made = await Promise.all(["Guide", "Show", "Old show", "Bonus show", "Bent show", "Flat show"].map((title) => addProduct(OWNER, title, "", "19", null)));
  if (!made.every((m) => m.ok)) throw new Error("setup");
  const [a, show, oldShow, bonusShow, bentShow, flatShow] = made.map((m) => (m.ok ? m.product.id : ""));
  await addStoreLink(OWNER, "My podcast", "https://example.com/pod");
  await addStoreLink(OWNER, "My blog", "https://example.com/blog");
  const listed = await addStoreLink(OWNER, "My shop", "https://example.com/shop");
  if (!listed.ok) throw new Error("setup");
  const [gone, kept, third] = listed.store.links.map((link) => link.id);
  const session = await openSession(OWNER);
  const folder = await imageFolder(OWNER);
  let n = 0;
  const name = () => `images/${folder}/${(++n).toString(16).padStart(32, "0")}.jpg`;
  const upload = async (payload: Record<string, string>) => {
    const pathname = name();
    const asked = await door(post("/api/store/image/upload", session, { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false } }));
    if (asked.status !== 200) throw new Error(`door ${asked.status}`);
    files.set(pathname, { bytes: JPEG, contentType: "image/jpeg", at: Date.now() + 1 });
    return pathname;
  };
  const linkAttach = (id: string, path: string, width = 320) => linkImage(post("/api/store/link-image", session, { action: "attach", id, path, width, height: 180 })).then(result);
  const linkPicture = async (id: string) => (await storeForEmail(OWNER))!.links.find((link) => link.id === id)?.image?.path ?? null;

  part("A link that is not there");
  const fresh = await upload({ linkId: gone });
  is("the link taken off in another tab", await result(await links(post("/api/store/links", session, { action: "remove", id: gone }))), [200, "ok"]);
  is("the new picture put on the link that is gone: refused, unknown", await linkAttach(gone, fresh), [404, "unknown"]);
  // Changed assertions, noted (Claude 5's correction on #2657): the fresh upload is taken from the door and deleted, never
  // left in storage with no owner; a new picture for the link that is there is put on as before.
  is("the fresh picture is taken from the door and deleted: it is never left in storage with no owner", files.has(fresh), false);
  const again = await upload({ linkId: kept });
  is("a new picture, chosen for a link that is there: put on", await linkAttach(kept, again), [200, "ok"]);
  is("and that link shows it", await linkPicture(kept), again);
  const aPicture = await upload({ productId: a });
  is("a new picture on product A", await result(await productImage(post("/api/store/image", session, { action: "attach", id: a, path: aPicture, width: 1200, height: 800 }))), [200, "ok"]);
  is("A's picture named for the link that is gone, with sizes the link refuses: unknown first", await linkAttach(gone, aPicture, 0), [404, "unknown"]);
  is("A's picture named for the link that is gone: unknown", await linkAttach(gone, aPicture), [404, "unknown"]);
  is("A's picture named for a link that is there: still in_use", await linkAttach(third, aPicture), [400, "in_use"]);
  is("A's picture is still there and still A's", [files.has(aPicture), (await readListing((await storeForEmail(OWNER))!, a))?.image?.path], [true, aPicture]);

  part("A podcast's episode is never its product's file");
  is("the show made a podcast", await result(await podcast(post("/api/store/podcast", session, { action: "enable", id: show }))), [200, "ok"]);
  const showFolder = fileFolder(await storeFolder(OWNER), show);
  const audio = `${showFolder}${"e".repeat(20)}.mp3`;
  const own = `${showFolder}${"f".repeat(20)}.mp3`;
  files.set(audio, { bytes: MP3, contentType: "audio/mpeg" });
  files.set(own, { bytes: MP3, contentType: "audio/mpeg" });
  is("an episode put out", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: show, pathname: audio, title: "Episode one", notes: "" }))), [200, "ok"]);
  const attachFile = (id: string, pathname: string) => fileAttach(post("/api/store/file/attach", session, { id, pathname, name: "audio.mp3" })).then(result);
  is("the episode's audio as the product's file: refused, in_use", await attachFile(show, audio), [400, "in_use"]);
  is("a file of its own on the podcast: refused as before, a podcast takes no file", await attachFile(show, own), [400, "course"]);
  is("the episode's audio is still there", files.has(audio), true);

  part("A file an episode still plays is never deleted with the product's file");
  is("the old show made a podcast", await result(await podcast(post("/api/store/podcast", session, { action: "enable", id: oldShow }))), [200, "ok"]);
  const oldFolder = fileFolder(await storeFolder(OWNER), oldShow);
  const shared = `${oldFolder}${"c".repeat(20)}.mp3`;
  files.set(shared, { bytes: MP3, contentType: "audio/mpeg" });
  is("an episode put out", await result(await podcast(post("/api/store/podcast", session, { action: "add", id: oldShow, pathname: shared, title: "Episode one", notes: "" }))), [200, "ok"]);
  // The same audio written down as the product's file too, as a record written before today's rules could hold it.
  is("seeded: the product's file is the episode's audio", seedFile(oldShow, { pathname: shared, name: "audio.mp3", bytes: MP3.length, contentType: "audio/mpeg", addedAt: "2026-01-01T00:00:00.000Z" }) > 0, true);
  is("the store reads it so", (await readListing((await storeForEmail(OWNER))!, oldShow))?.file?.pathname, shared);
  is("the product's file taken off", await result(await fileAttach(post("/api/store/file/attach", session, { id: oldShow, detach: true }))), [200, "ok"]);
  is("the product shows no file", (await readListing((await storeForEmail(OWNER))!, oldShow))?.file ?? null, null);
  is("the audio the episode still plays is kept", files.has(shared), true);
  const episodes = await readPodcast((await readListing((await storeForEmail(OWNER))!, oldShow))!.podcast!.id);
  is("and the episode still names it", episodes?.episodes.map((episode) => episode.pathname), [shared]);

  part("A price option of a podcast whose record was never written");
  // The enable writes the product's reference before the podcast's record (app/api/store/podcast); a record that
  // failed to be written leaves a podcast with no record, and a second enable answers ok without writing it.
  is("the bonus show made a podcast", await result(await podcast(post("/api/store/podcast", session, { action: "enable", id: bonusShow }))), [200, "ok"]);
  const bonusRef = (await readListing((await storeForEmail(OWNER))!, bonusShow))!.podcast!.id;
  await dropPodcast(bonusRef);
  is("its record is not there", await readPodcast(bonusRef), null);
  const priced = await addOption(OWNER, bonusShow, "With the workbook", "29");
  if (!priced.ok) throw new Error("option");
  const bonusOption = (await readListing(priced.store, bonusShow))!.options[0].id;
  const bonusFile = `${fileFolder(await storeFolder(OWNER), bonusOption)}${"b".repeat(20)}.pdf`;
  files.set(bonusFile, { bytes: MP3, contentType: "application/pdf" });
  is("a bonus file on the option: put on (it was a server error)", await attachFile(bonusOption, bonusFile), [200, "ok"]);
  is("the option shows it", (await readListing((await storeForEmail(OWNER))!, bonusShow))!.options[0].file?.pathname, bonusFile);

  part("A podcast record not in its exact form keeps the file");
  /** A podcast with one episode whose audio is also the product's file, and then its record written as `bent`. */
  const bentCase = async (id: string, letter: string, bent: (record: { id: string; episodes: Record<string, unknown>[] }) => unknown) => {
    is(`${letter}: made a podcast`, await result(await podcast(post("/api/store/podcast", session, { action: "enable", id }))), [200, "ok"]);
    const audioPath = `${fileFolder(await storeFolder(OWNER), id)}${letter.repeat(20)}.mp3`;
    files.set(audioPath, { bytes: MP3, contentType: "audio/mpeg" });
    is(`${letter}: an episode put out`, await result(await podcast(post("/api/store/podcast", session, { action: "add", id, pathname: audioPath, title: "Episode one", notes: "" }))), [200, "ok"]);
    is(`${letter}: seeded, the product's file is the episode's audio`, seedFile(id, { pathname: audioPath, name: "audio.mp3", bytes: MP3.length, contentType: "audio/mpeg", addedAt: "2026-01-01T00:00:00.000Z" }) > 0, true);
    const ref = (await readListing((await storeForEmail(OWNER))!, id))!.podcast!.id;
    const record = JSON.parse(String(redis.run(["GET", `nl:pod:${ref}`]))) as { id: string; episodes: Record<string, unknown>[] };
    redis.run(["SET", `nl:pod:${ref}`, JSON.stringify(bent(record))]);
    is(`${letter}: the product's file taken off`, await result(await fileAttach(post("/api/store/file/attach", session, { id, detach: true }))), [200, "ok"]);
    is(`${letter}: the audio is kept`, files.has(audioPath), true);
  };
  await bentCase(bentShow, "9", (record) => ({ ...record, episodes: record.episodes.map((episode) => ({ ...episode, id: "NOT-AN-ID" })) }));
  await bentCase(flatShow, "8", (record) => ({ ...record, episodes: { first: record.episodes[0] } }));

  part("Neither read finds the product: unknown, so kept");
  // Read by name, so this file still runs (and fails) on a head without it.
  const asked = (podcastStore as Record<string, unknown>).audioPlayedBy;
  const audioPlayedBy = (product: { podcast: { id: string; episodes: number } | null } | null) =>
    typeof asked === "function" ? (asked as (p: typeof product) => Promise<Set<string> | null>)(product) : Promise.resolve(new Set(["(not there)"]));
  is("no product read before or after the write: unknown, not \"no episodes\"", await audioPlayedBy(null), null);
  is("a product that is not a podcast: none", [...((await audioPlayedBy({ podcast: null })) ?? ["unknown"])], []);
  is("a podcast whose record is not there: none, no episode can name a file", [...((await audioPlayedBy({ podcast: { id: bonusRef, episodes: 0 } })) ?? ["unknown"])], []);
  const routeSource = readFileSync("app/api/store/file/attach/route.ts", "utf8");
  // Claude 4 on #2657 (cost): a new file reuses the product read before the write; a detach reads it once, after.
  is("the route asks with the product read before the write for a new file, or the one read after a detach, and nothing else", routeSource.includes("(delivery ? Promise.resolve(delivery) : readDelivery(result.store, id)).then((found) => audioPlayedBy(found?.product))") && routeSource.includes("const delivery = detach ? null : await readDelivery(store, id);"), true);

  part("What the creator reads");
  const messageOf = (file: string, key: string) => readFileSync(file, "utf8").match(new RegExp(`\\n  ${key}: [\`"]([^\`"]*)[\`"]`))?.[1] ?? "";
  is("the podcast editor's refusal is true for another episode's audio and for the product's own file", messageOf("components/podcast-editor.tsx", "in_use"), "That audio file is already used on this product. Choose the file from your device again.");
  is("the product editor has words for the file route's refusal", messageOf("components/product-editor.tsx", "in_use"), "That file is already used on this product. Choose the file from your device again.");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
