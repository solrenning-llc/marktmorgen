/**
 * Proof only (RED), 6 November 2026, under the margin rule (MR, 27 October 2026): every paid supplier spend needs
 * an automatic ceiling before it happens, and an unknown cost is never zero.
 *
 * A store's product pictures are served by app/api/image/[folder]/[file]/route.ts, which reads each one from the
 * file store (Vercel Blob, `get` from lib/blob) whenever the CDN does not hold that address, and a product's shared
 * card (app/[handle]/p/[product]/opengraph-image.tsx) reads the product's picture the same way. What stands before
 * the picture route's read is only a pace held in one server's memory (lib/picture-pace.ts): 120 answers a minute
 * per connection and 30 reads a minute per picture, each per server instance. The shared card has no pace at all.
 * Neither takes any store figure (no takePublicRequest, no withinStore), and tests/plan-cost-registry.ts prices a
 * picture only as a CDN request inside the visits line (PICTURES_PER_MINUTE: "what it lets through is the CDN's
 * picture of line visits"): no function call, no Blob read and no Blob data transfer (BLOB_TRANSFER_PER_BYTE, up to
 * MAX_IMAGE_BYTES a picture) is in any plan's month.
 *
 * Each check below sends the real handlers synthetic requests, with synthetic pictures in a file store held in
 * memory that counts its reads (tests/picture-serve-world.ts, which also stands in for the card drawer of next/og:
 * the card's read happens before anything is drawn), from many synthetic connections:
 *
 *   - controls: a stored picture is served whole, kept for a year, with one read; a query string is sent to the
 *     plain address with no read; the two in-memory paces refuse with no read;
 *   - RED: each read of the file store moves a store-held figure in the database first (today nothing is written);
 *   - RED: in one minute, on one server, the reads one creator store's public pictures cause stay within the
 *     creator plan's public-request figure for a whole month (today 12,000 reads pass, above 10,700);
 *   - RED: a picture name the store never kept still costs a read of the file store, counted against nothing;
 *   - RED: the shared card reads the picture with no store figure taken.
 *
 * What would make the RED checks pass is a fix in the product, not here: nothing in app/, lib/ or components/ is
 * changed by this file.
 */
import { claimHandle, addProduct, ensureStatsId, imageFolder, setProductImage } from "@/lib/store";
import { PICTURES_PER_MINUTE, PICTURE_READS_PER_MINUTE } from "@/lib/picture-pace";
import { EXTRA_REQUESTS, REQUESTS_PER_VISIT, VISITS_INCLUDED } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { calls, files, gets, resetCalls } from "./picture-serve-world";
import { done, is, part } from "./check";
import { GET as picture } from "@/app/api/image/[folder]/[file]/route";
import OpengraphImage from "@/app/[handle]/p/[product]/opengraph-image";

const OWNER = "serve.cost@example.com";
const ORIGIN = "https://marktmorgen.com";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

/** Redis commands that only read; anything else sent during a request is a figure moved. */
const READS = new Set(["GET", "MGET", "EXISTS", "TTL", "PTTL", "PEXPIRETIME", "EXPIRETIME", "STRLEN", "TYPE", "HGET", "HMGET", "HGETALL", "HLEN", "HEXISTS", "SMEMBERS", "SISMEMBER", "SCARD", "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZSCORE", "ZCARD", "ZCOUNT", "LRANGE", "LLEN", "LINDEX", "SCAN", "KEYS"]);
const sent: string[][] = [];
const original = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String));
  return original(commands);
};
const writes = () => sent.filter((command) => !READS.has(String(command[0]).toUpperCase())).length;

/** The creator plan's public requests in a month, worked out as tests/plan-cost-registry.ts (line public-requests) does. */
const CREATOR_REQUESTS = REQUESTS_PER_VISIT * VISITS_INCLUDED.creator + EXTRA_REQUESTS.creator;

let n = 0;
const name = () => `${(++n).toString(16).padStart(32, "0")}.jpg`;
/** A connection of its own for each number: 10.x.y.z, as the host hands the route in x-forwarded-for. */
const address = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
const ask = (folder: string, file: string, from: string, query = "") =>
  picture(new Request(`${ORIGIN}/api/image/${folder}/${file}${query}`, { headers: { "x-forwarded-for": from } }), { params: Promise.resolve({ folder, file }) });

async function main(): Promise<void> {
  const started = Date.now();
  redis.clear();
  files.clear();
  const claimed = await claimHandle(OWNER, "servecost", "Serve Cost", "");
  if (!claimed.ok) throw new Error("setup: handle");
  await ensureStatsId(OWNER);
  const folder = await imageFolder(OWNER);
  const keep = (file: string) => files.set(`images/${folder}/${file}`, { bytes: JPEG, contentType: "image/jpeg" });

  part("Controls: what the route does today, and keeps doing");
  {
    const file = name();
    keep(file);
    resetCalls();
    const response = await ask(folder, file, "192.0.2.1");
    const body = new Uint8Array(await response.arrayBuffer());
    is("a stored picture is served", response.status, 200);
    is("whole, byte for byte", Array.from(body), Array.from(JPEG));
    is("kept for a year by the CDN and the browser", response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    is("with one read of the file store", calls.get, 1);
    resetCalls();
    const moved = await ask(folder, file, "192.0.2.1", "?1");
    is("a query string is sent to the plain address", [moved.status, moved.headers.get("location")], [308, `/api/image/${folder}/${file}`]);
    is("with no read of the file store", calls.get, 0);
  }
  {
    // One connection: its minute of answers on this server, then a refusal that reads nothing.
    const mine = Array.from({ length: PICTURES_PER_MINUTE + 1 }, name);
    for (const file of mine) keep(file);
    resetCalls();
    const statuses: number[] = [];
    for (const file of mine) statuses.push((await ask(folder, file, "192.0.2.2")).status);
    is("one connection: its minute's pictures are answered", statuses.slice(0, PICTURES_PER_MINUTE).every((s) => s === 200), true);
    is("one connection: the next is refused", statuses[PICTURES_PER_MINUTE], 429);
    is("one connection: the refusal read nothing", calls.get, PICTURES_PER_MINUTE);
  }
  {
    // One picture: its minute of reads on this server, then a refusal that reads nothing.
    const file = name();
    keep(file);
    resetCalls();
    const statuses: number[] = [];
    for (let i = 0; i <= PICTURE_READS_PER_MINUTE; i++) statuses.push((await ask(folder, file, address(1_000 + i))).status);
    is("one picture: its minute's reads are answered", statuses.slice(0, PICTURE_READS_PER_MINUTE).every((s) => s === 200), true);
    is("one picture: the next is refused", statuses[PICTURE_READS_PER_MINUTE], 429);
    is("one picture: the refusal read nothing", calls.get, PICTURE_READS_PER_MINUTE);
  }

  part("RED: a read of the file store moves a store figure first");
  {
    const pictures = Array.from({ length: 40 }, name);
    for (const file of pictures) keep(file);
    let uncounted = 0;
    let reads = 0;
    for (const [i, file] of pictures.entries()) {
      resetCalls();
      const before = writes();
      const response = await ask(folder, file, address(5_000 + i));
      await response.arrayBuffer();
      reads += calls.get;
      if (calls.get > 0 && writes() === before) uncounted += 1;
    }
    console.log(`        ${reads} reads of the file store from ${pictures.length} connections, ${uncounted} with no figure written in the database`);
    is("every read of a store's picture is counted against a store figure before it happens", uncounted, 0);
  }

  part(`RED: a month of one creator store's picture reads stays within its public requests (${CREATOR_REQUESTS.toLocaleString("en-US")})`);
  {
    // 400 pictures, each read PICTURE_READS_PER_MINUTE times; 100 connections, each asking PICTURES_PER_MINUTE:
    // every request is inside both paces, on one server, in one minute.
    const PICTURES = 400;
    const CONNECTIONS = (PICTURES * PICTURE_READS_PER_MINUTE) / PICTURES_PER_MINUTE;
    const pictures = Array.from({ length: PICTURES }, name);
    for (const file of pictures) keep(file);
    resetCalls();
    const before = writes();
    let served = 0;
    for (let c = 0; c < CONNECTIONS; c++) {
      for (let k = 0; k < PICTURES_PER_MINUTE; k++) {
        const response = await ask(folder, pictures[(c * PICTURES_PER_MINUTE + k) % PICTURES], address(20_000 + c));
        if (response.status === 200) served += 1;
      }
    }
    const elapsed = Date.now() - started;
    console.log(`        ${served} pictures served, ${calls.get} reads of the file store, ${writes() - before} figures written, ${elapsed} ms since the start`);
    is("the pace window did not turn while this ran (the scenario is one minute on one server)", elapsed < 60_000, true);
    is("reads in one minute on one server stay within the creator plan's month of public requests", calls.get <= CREATOR_REQUESTS, true);
  }

  part("RED: a name the store never kept still costs a read, counted against nothing");
  {
    resetCalls();
    const before = writes();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await ask(folder, name(), address(40_000 + i))).status);
    console.log(`        ${statuses.filter((s) => s === 404).length} answers "not found", ${calls.get} reads of the file store, ${writes() - before} figures written`);
    is("made-up names: each read of the file store is counted against a store figure first", calls.get === 0 || writes() - before >= calls.get, true);
  }

  part("RED: a product's shared card reads its picture with no store figure taken");
  {
    const made = await addProduct(OWNER, "Card guide", "", "19", null);
    if (!made.ok) throw new Error("setup: product");
    const path = `images/${folder}/${name()}`;
    files.set(path, { bytes: JPEG, contentType: "image/jpeg" });
    const set = await setProductImage(OWNER, made.product.id, { path, width: 1200, height: 800, alt: "", bytes: JPEG.length, small: null });
    if (!set.ok) throw new Error("setup: picture");
    resetCalls();
    const before = writes();
    await OpengraphImage({ params: Promise.resolve({ handle: "@servecost", product: made.product.id }) });
    console.log(`        ${gets.filter((g) => g === path).length} read of the product's picture, ${writes() - before} figures written`);
    is("control: the card reads the product's picture", gets.includes(path), true);
    is("the card's read of the file store is counted against a store figure first", writes() - before >= 1, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
