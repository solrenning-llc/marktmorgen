/**
 * CX-123 rule 24 on two public answers of a store's own address (r24-fresh-2,
 * unit 2, 10 November 2026): a read that failed or came back out of shape is
 * unknown, never "not there", and nothing unknown is kept by a cache.
 *
 *   - The home-screen icon (app/[handle]/app-icon/[size]/route.tsx): a store
 *     with a photo whose photo could not be read, or could not be scaled, was
 *     answered with the store's letter and "immutable" for a year, at an
 *     address that changes only with the photo, the theme, the colour or the
 *     letter. The CDN and every phone that installed the store kept the
 *     letter in place of the photo. A long cache is now given only to an icon
 *     drawn from a photo that was read, or to the letter when there is
 *     confirmed to be no photo.
 *   - The store's map for search engines (app/[handle]/store-sitemap/route.ts):
 *     a store that could not be read was answered 404 "Not found", which a
 *     search engine reads as a map taken down. It now answers 503 with
 *     Retry-After; 404 only for a store confirmed not there or suspended.
 *
 * Each unknown case is checked against a control where the same thing is
 * truly absent, which keeps its old answer. Synthetic store; one reply
 * injected per case; no network.
 */
import { GET as iconRoute } from "@/app/[handle]/app-icon/[size]/route";
import { GET as sitemapRoute } from "@/app/[handle]/store-sitemap/route";
import { claimHandle, setPhotoId, setSubscription, storeForEmail } from "@/lib/store";
import { writePhoto } from "@/lib/store-photo";
import { iconUrl } from "@/lib/store-app";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { world } from "./store-public-unknown-world";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: { when: (c: Command) => boolean; reply: () => unknown[] | Promise<unknown[]> } | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some(inject.when)) return inject.reply();
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

const failed = () => Promise.reject(new Error("synthetic Redis failure"));
const getOf = (prefix: string) => (c: Command) => c[0] === "GET" && typeof c[1] === "string" && c[1].startsWith(prefix);
const YEAR = "public, max-age=31536000, immutable";

let visitor = 0;
/** Each call from its own address, so the per-connection pace never answers for the route. */
const from = () => ({ "x-forwarded-for": `203.0.113.${(visitor += 1) % 250}` });

async function main(): Promise<void> {
  redis.clear();
  const owner = "store-public-unknown@example.test";
  await claimHandle(owner, "pubunknown", "Public Unknown", "");
  await setSubscription(owner, { customerId: "cus_PubUnk00001", subscriptionId: "sub_PubUnk00001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const photoId = await writePhoto(new Uint8Array([1, 2, 3, 4]), "image/webp");
  const set = await setPhotoId(owner, photoId);
  if (!set.ok) throw new Error("photo fixture");
  const plainOwner = "store-public-unknown-plain@example.test";
  await claimHandle(plainOwner, "pubplain", "Plain Store", "");
  const withPhoto = (await storeForEmail(owner))!;
  const plain = (await storeForEmail(plainOwner))!;
  if (withPhoto.photoId !== photoId || plain.photoId) throw new Error("store fixtures");

  // Spread over the three sizes, so the per-file pace (30 a minute) never answers for the route.
  const sizes = [180, 192, 512] as const;
  let turn = 0;
  const icon = async (store: typeof withPhoto, handle = `@${store.handle}`) => {
    const size = sizes[(turn += 1) % sizes.length];
    const response = await iconRoute(new Request(`https://marktmorgen.com${iconUrl(store, size)}`, { headers: from() }), {
      params: Promise.resolve({ handle, size: `${size}.png` }),
    });
    const body = Buffer.from(await response.arrayBuffer()).toString("latin1");
    return { status: response.status, cache: response.headers.get("cache-control"), body };
  };
  const longKept = (answer: { cache: string | null }) => /max-age=(?!0\b)|immutable|s-maxage/.test(answer.cache ?? "");

  part("The icon: controls");
  const healthy = await icon(withPhoto);
  is("a store's photo is drawn as its icon", [healthy.status, healthy.body.startsWith("PHOTO:")], [200, true]);
  is("and kept for a year", healthy.cache, YEAR);
  const letter = await icon(plain);
  is("a store with no photo is drawn with its letter", [letter.status, letter.body.startsWith("LETTER:")], [200, true]);
  is("and kept for a year", letter.cache, YEAR);
  inject = { when: getOf("nl:store:photo:"), reply: () => [null] };
  const gone = await icon(withPhoto);
  inject = null;
  is("a photo confirmed gone (an exact null) is drawn with the letter", [gone.status, gone.body.startsWith("LETTER:")], [200, true]);
  is("and kept for a year: that photo id will never hold a photo again", gone.cache, YEAR);
  inject = { when: getOf("nl:store:photo:"), reply: () => ["text/plain;AAAA"] };
  const unusable = await icon(withPhoto);
  inject = null;
  is("a photo record that holds no picture is drawn with the letter", [unusable.status, unusable.body.startsWith("LETTER:")], [200, true]);
  is("and kept for a year: what Redis holds under that id is what it is", unusable.cache, YEAR);
  const nobody = await icon(plain, "@nobodyhere");
  is("a store that does not exist is not found, kept by no cache", [nobody.status, nobody.cache], [404, "no-store"]);

  part("The icon: a photo that could not be read");
  for (const [name, reply] of [
    ["the photo's read failed", failed],
    ["no reply for the photo", () => []],
    ["a number for the photo", () => [7]],
    ["a list for the photo", () => [["x"]]],
    ["two replies for the photo", () => ["image/webp;AAAA", "x"]],
  ] as const) {
    inject = { when: getOf("nl:store:photo:"), reply };
    const answer = await icon(withPhoto);
    inject = null;
    is(`${name}: the letter is never kept in place of the photo`, longKept(answer), false);
    is(`${name}: never answered as a drawn icon`, answer.status === 200, false);
    is(`${name}: kept by no cache`, answer.cache, "no-store");
  }

  part("The icon: a photo that could not be scaled");
  world.scalingFails = true;
  const unscaled = await icon(withPhoto);
  world.scalingFails = false;
  is("the letter drawn instead is never kept for a year", longKept(unscaled), false);
  is("kept by no cache", unscaled.cache, "no-store");
  const again = await icon(withPhoto);
  is("once scaling works again, the photo is drawn and kept", [again.status, again.body.startsWith("PHOTO:"), again.cache], [200, true, YEAR]);

  part("The icon: a store that could not be read");
  for (const [name, when, reply] of [
    ["the address's read failed", getOf("nl:store:handle:"), failed],
    ["no reply for its address", getOf("nl:store:handle:"), () => []],
    ["a number for its address", getOf("nl:store:handle:"), () => [7]],
    ["no reply for its record", getOf("nl:store:owner:"), () => []],
  ] as const) {
    inject = { when, reply };
    const answer = await icon(withPhoto);
    inject = null;
    is(`${name}: never "not found"`, answer.status === 404, false);
    is(`${name}: never a drawn icon`, answer.status === 200, false);
    is(`${name}: kept by no cache`, answer.cache, "no-store");
  }
  inject = { when: getOf("nl:store:handle:"), reply: () => [null] };
  const free = await icon(withPhoto);
  inject = null;
  is("control: an address confirmed free is not found", [free.status, free.cache], [404, "no-store"]);

  const sitemap = async (handle: string) => {
    const response = await sitemapRoute(new Request(`https://marktmorgen.com/${handle}/sitemap.xml`), { params: Promise.resolve({ handle }) });
    return { status: response.status, retry: response.headers.get("retry-after"), cache: response.headers.get("cache-control"), type: response.headers.get("content-type") };
  };

  part("The map: controls");
  const map = await sitemap("@pubunknown");
  is("a store's map is answered as XML", [map.status, map.type], [200, "application/xml; charset=utf-8"]);
  const noMap = await sitemap("@nobodyhere");
  is("a store that does not exist is not found", noMap.status, 404);
  inject = { when: getOf("nl:store:handle:"), reply: () => [null] };
  const freeMap = await sitemap("@pubunknown");
  inject = null;
  is("an address confirmed free (an exact null) is not found", freeMap.status, 404);

  part("The map: a store that could not be read");
  for (const [name, when, reply] of [
    ["the address's read failed", getOf("nl:store:handle:"), failed],
    ["no reply for its address", getOf("nl:store:handle:"), () => []],
    ["a number for its address", getOf("nl:store:handle:"), () => [7]],
    ["a list for its address", getOf("nl:store:handle:"), () => [["x"]]],
    ["the record's read failed", getOf("nl:store:owner:"), failed],
    ["no reply for its record", getOf("nl:store:owner:"), () => []],
  ] as const) {
    inject = { when, reply };
    const answer = await sitemap("@pubunknown");
    inject = null;
    is(`${name}: never "not found" to a search engine`, answer.status === 404, false);
    is(`${name}: 503, come back in an hour, kept by no cache`, [answer.status, answer.retry, answer.cache], [503, "3600", "no-store"]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
