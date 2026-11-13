/**
 * 33 [F2], part 2: the public podcast feed's route (app/api/store/podcast/public/[handle]/[product]/route.ts), over
 * the pure feed of part 1 (lib/podcast-public-feed.ts) and the show's public settings (lib/podcast-public-show.ts).
 *
 * What is checked:
 *   - only an episode marked exactly "public" appears, with the https audio address kept for it: the route never
 *     signs, proxies or sends audio bytes, and never names a buyer's feed or play address;
 *   - every answer is counted in the store's public request window before it is sent: a feed built is held at
 *     PUBLIC_FEED_HOLD_UNITS before anything past the store is read and keeps PUBLIC_FEED_BUILD_UNITS and the units
 *     of the bytes it read, and the bytes sent take one unit per PUBLIC_FEED_BYTES_PER_UNIT before the body goes; a
 *     window that is spent gets a 503 with Retry-After, no feed;
 *   - the XML is kept PUBLIC_FEED_CACHE_SECONDS in a bounded cache, so an app asking again reads nothing from Redis
 *     (only the count is written), and an app that sends the ETag back is answered 304 with no body;
 *   - rule 24: a store, listing, podcast or settings record that cannot be read gives a 503, never an empty feed,
 *     and is not kept; a show with no public settings, a draft and a product that is not a podcast give a 404;
 *   - the units are priced above what the answer costs (tests/plan-cost-registry.ts and tests/traffic-cost.ts).
 *
 * Synthetic data only; the Redis double, no network.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET } from "@/app/api/store/podcast/public/[handle]/[product]/route";
import {
  PODCAST_RECORD_MOST,
  PUBLIC_FEED_BUILD_UNITS,
  PUBLIC_FEED_BYTES_PER_UNIT,
  PUBLIC_FEED_CACHE_BYTES,
  PUBLIC_FEED_CACHE_ENTRIES,
  PUBLIC_FEED_CACHE_SECONDS,
  PUBLIC_FEED_HOLD_UNITS,
  PUBLIC_FEED_READ_COMMANDS,
  PUBLIC_SHOW_MAX_BYTES,
  buildUnits,
  byteUnits,
  cachedFeed,
  forgetPublicFeeds,
  keepFeed,
  sendUnits,
} from "@/lib/podcast-public-show";
import { savePodcast } from "@/lib/podcast";
import { PublicFeedError, publicFeedXml } from "@/lib/podcast-public-feed";
import type { Podcast } from "@/lib/podcast-rules";
import { requestsIn } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import { MAX_STORE_BYTES, addProduct, claimHandle, ensureStatsId, setProductHidden, setProductPodcast, setSubscription, noteTakedown, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { laterPageCost } from "./traffic-cost";
import { COMMAND, DB_BYTE, ORIGIN_PER_BYTE, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "tide@example.com";
const HANDLE = "tidecast";
const POD = "a".repeat(32);
const TOKEN = "f".repeat(48);

/** Every command sent to the store from here on, as text. */
const sent: string[] = [];
const original = redis.pipeline.bind(redis);
let bend: ((commands: (string | number)[][]) => unknown) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sent.push(command.map(String).join(" "));
  if (bend) {
    const bent = bend(commands);
    if (bent !== undefined) return bent;
  }
  return original(commands);
}) as typeof redis.pipeline;

let fetched = 0;
globalThis.fetch = (async () => {
  fetched += 1;
  throw new Error("no request may be made here");
}) as typeof fetch;

const show = (episodes: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ category: "Education", explicit: false, episodes, ...extra });

function podcast(): Podcast {
  const at = 1_790_000_000;
  const one = (id: string, title: string, n: number) => ({ id, title, notes: `About ${title}`, pathname: `stores/x/p/${id}.mp3`, bytes: 1000 + n, contentType: "audio/mpeg", at: at + n * 1000 });
  return {
    id: POD,
    episodes: [
      one("ep0000000001", "Public one", 1),
      one("ep0000000002", "Paid two", 2),
      one("ep0000000003", "Shouting three", 3),
      one("ep0000000004", "Unmarked four", 4),
      one("ep0000000005", "Insecure five", 5),
      one("ep0000000006", "Buyer six", 6),
      one("ep0000000007", "Public seven", 7),
    ],
  };
}

const AUDIO = "https://cdn.example.org/tide/ep1.mp3";
const SEVEN = "https://cdn.example.org/tide/ep7.m4a?v=2";
const SETTINGS = show({
  ep0000000001: { visibility: "public", audio: AUDIO },
  ep0000000002: { visibility: "paid", audio: "https://cdn.example.org/tide/ep2.mp3" },
  ep0000000003: { visibility: "PUBLIC", audio: "https://cdn.example.org/tide/ep3.mp3" },
  ep0000000005: { visibility: "public", audio: "http://cdn.example.org/tide/ep5.mp3" },
  ep0000000006: { visibility: "public", audio: `https://cdn.example.org/${TOKEN}/ep6.mp3` },
  ep0000000007: { visibility: "public", audio: SEVEN },
  ep9999999999: { visibility: "public", audio: "https://cdn.example.org/tide/gone.mp3" },
});

async function writeShow(text: string | null): Promise<void> {
  await original([text === null ? ["DEL", `nl:pod:${POD}:public`] : ["SET", `nl:pod:${POD}:public`, text]]);
}

const get = (product: string, headers: Record<string, string> = {}, handle = HANDLE) =>
  GET(new NextRequest(`https://marktmorgen.com/api/store/podcast/public/${handle}/${product}`, { headers }), { params: Promise.resolve({ handle, product }) });

const reads = () => sent.filter((c) => /^(GET|MGET|HGET|HGETALL|SMEMBERS|LRANGE|ZRANGE)\b/.test(c));

async function main(): Promise<void> {
  redis.clear();
  forgetPublicFeeds();
  await claimHandle(OWNER, HANDLE, "Tide Talks", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_tide00001", subscriptionId: "sub_tide00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Tide Talks Weekly", "A weekly show about the sea.", "9", null);
  if (!made.ok) throw new Error("no product");
  const pid = made.product.id;
  const attached = await setProductPodcast(OWNER, pid, { id: POD, episodes: 7 });
  if (!attached.ok) throw new Error(`no podcast: ${attached.reason}`);
  await savePodcast(podcast());
  await writeShow(SETTINGS);
  const store = (await storeForEmail(OWNER)) as Store;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;

  part("Only the episodes marked exactly public, at the audio address kept for them");
  let before = await requestsIn(folder, window);
  sent.length = 0;
  const first = await get(`${pid}.xml`);
  const xml = await first.text();
  const bytes = Buffer.byteLength(xml, "utf8");
  is("answered 200 as an RSS document", [first.status, first.headers.get("content-type")], [200, "application/rss+xml; charset=utf-8"]);
  const guids = [...xml.matchAll(/<guid isPermaLink="false">([^<]+)<\/guid>/g)].map((m) => m[1]);
  is("the two public episodes, newest first; paid, PUBLIC, unmarked, http and token-shaped audio left out", guids, ["ep0000000007", "ep0000000001"]);
  is("each enclosure is the https address kept for it, escaped", [xml.includes(`url="${AUDIO}"`), xml.includes(`url="${SEVEN}"`)], [true, true]);
  is("no buyer's play or feed address, no itunes:block, no token", [xml.includes("/api/store/podcast/play/"), xml.includes("/api/store/podcast/feed/"), xml.includes("itunes:block"), xml.includes(TOKEN)], [false, false, false, false]);
  is("the show's title, category and explicit flag", [xml.includes("<title>Tide Talks Weekly</title>"), xml.includes('<itunes:category text="Education"/>'), xml.includes("<itunes:explicit>false</itunes:explicit>")], [true, true, true]);
  is("an ETag, and caches told to ask again each time (never kept by a CDN uncounted)", [Boolean(first.headers.get("etag")), first.headers.get("cache-control")], [true, "no-cache"]);
  const readBytes = Buffer.byteLength(JSON.stringify(podcast()), "utf8") + Buffer.byteLength(SETTINGS, "utf8");
  is("a feed built keeps PUBLIC_FEED_BUILD_UNITS, the units of what it read, and one per PUBLIC_FEED_BYTES_PER_UNIT sent", (await requestsIn(folder, window)) - before, PUBLIC_FEED_BUILD_UNITS + byteUnits(readBytes)! + sendUnits(bytes)!);
  is("the hold's rest was given back", buildUnits(readBytes)! < PUBLIC_FEED_HOLD_UNITS, true);
  is("no request to any other service, and no audio read", fetched, 0);

  part("Kept in a bounded cache: asked again, nothing is read from Redis, only the count written");
  before = await requestsIn(folder, window);
  sent.length = 0;
  const again = await get(`${pid}.xml`);
  is("the same feed", [again.status, await again.text()], [200, xml]);
  is("no read of the store, listing, podcast or settings", reads().filter((c) => !c.startsWith("GET nl:traffic:r:")), []);
  is("a kept feed takes only the units of its bytes, one at least", (await requestsIn(folder, window)) - before, sendUnits(bytes));

  part("An app that sends the ETag back is answered 304, with no body, and counted once");
  before = await requestsIn(folder, window);
  const etag = first.headers.get("etag") ?? "";
  const same = await get(`${pid}.xml`, { "if-none-match": etag });
  is("304, empty", [same.status, await same.text(), same.headers.get("etag")], [304, "", etag]);
  is("one unit", (await requestsIn(folder, window)) - before, 1);
  const other = await get(`${pid}.xml`, { "if-none-match": '"something-else"' });
  is("another tag gets the feed", [other.status, (await other.text()) === xml], [200, true]);

  part("The cache forgets after PUBLIC_FEED_CACHE_SECONDS");
  const realNow = Date.now;
  Date.now = () => realNow() + (PUBLIC_FEED_CACHE_SECONDS + 1) * 1000;
  try {
    sent.length = 0;
    const later = await get(`${pid}.xml`);
    is("built again from the records", [later.status, reads().some((c) => c === `GET nl:pod:${POD}:public`)], [200, true]);
  } finally {
    Date.now = realNow;
  }

  part("A spent window: a 503 that apps understand, never a feed");
  forgetPublicFeeds();
  const spent = requestLimitFor(store, Date.now() / 1000);
  await original([["SET", `nl:traffic:r:${folder}:${window}`, spent + 10]]);
  const resting = await get(`${pid}.xml`);
  const restingBody = await resting.text();
  is("503 with Retry-After, not stored", [resting.status, Boolean(resting.headers.get("retry-after")), resting.headers.get("cache-control")], [503, true, "no-store"]);
  is("no feed in it", restingBody.includes("<rss"), false);
  sent.length = 0;
  const restingAgain = await get(`${pid}.xml`);
  is("refused before the podcast or its settings are read", [restingAgain.status, reads().some((c) => c.startsWith(`GET nl:pod:${POD}`))], [503, false]);
  // A kept feed, too, is not sent while the window is spent.
  await original([["SET", `nl:traffic:r:${folder}:${window}`, 0]]);
  forgetPublicFeeds();
  is("built while there is room", (await get(`${pid}.xml`)).status, 200);
  await original([["SET", `nl:traffic:r:${folder}:${window}`, spent + 10]]);
  is("then refused although kept", (await get(`${pid}.xml`)).status, 503);
  await original([["SET", `nl:traffic:r:${folder}:${window}`, 0]]);

  part("The hold comes before the listing is read: a missing or unknown listing is admitted first and paid (Codex H2 on #3513)");
  // The product held off the catalog's head, as a store with many products keeps most of them: its listing is a GET.
  const offHead = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(offHead);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "head" && Array.isArray(v) ? [] : offHead(v)]));
    return value;
  };
  const catalogId = store.catalog.id!;
  const listingGet = `GET nl:catalog:${catalogId}:l:${pid}`;
  const listingAs = (reply: unknown) => (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0].map(String).join(" ") === listingGet) return reply;
    return original(commands).then((replies: unknown) => (Array.isArray(replies) ? replies.map((r) => (typeof r === "string" && r.includes('"head"') ? JSON.stringify(offHead(JSON.parse(r))) : r)) : replies));
  };
  for (const [what, reply] of [["missing (null)", [null]], ["unknown (a number)", [7]]] as const) {
    forgetPublicFeeds();
    await original([["SET", `nl:traffic:r:${folder}:${window}`, spent + 10]]);
    bend = listingAs(reply);
    for (let n = 0; n < 3; n += 1) {
      sent.length = 0;
      const answer = await get(`${pid}.xml`);
      is(`${what}, window spent, request ${n + 1}: 503 resting, the listing never read`, [answer.status, Boolean(answer.headers.get("retry-after")), sent.includes(listingGet)], [503, true, false]);
    }
    bend = null;
    await original([["SET", `nl:traffic:r:${folder}:${window}`, 0]]);
  }
  forgetPublicFeeds();
  bend = listingAs([null]);
  before = await requestsIn(folder, window);
  sent.length = 0;
  const missing = await get(`${pid}.xml`);
  bend = null;
  is("missing, with room: read after the hold, 404, and the base kept (the store and the listing read), the rest given back", [missing.status, sent.includes(listingGet), (await requestsIn(folder, window)) - before], [404, true, PUBLIC_FEED_BUILD_UNITS]);
  forgetPublicFeeds();
  bend = listingAs([7]);
  before = await requestsIn(folder, window);
  const unknown = await get(`${pid}.xml`);
  bend = null;
  is("unknown, with room: 503, and the whole hold kept (unknown is never zero)", [unknown.status, (await requestsIn(folder, window)) - before], [503, PUBLIC_FEED_HOLD_UNITS]);
  await original([["SET", `nl:traffic:r:${folder}:${window}`, 0]]);
  forgetPublicFeeds();
  is("control: the feed is built again with the listing on the head", (await get(`${pid}.xml`)).status, 200);

  part("Rule 24: a record that cannot be read gives a 503, never an empty feed, and is not kept");
  const bents: [string, string, unknown][] = [
    ["the settings: no reply", `GET nl:pod:${POD}:public`, []],
    ["the settings: two replies", `GET nl:pod:${POD}:public`, [null, null]],
    ["the settings: a number", `GET nl:pod:${POD}:public`, [7]],
    ["the settings: text that does not parse", `GET nl:pod:${POD}:public`, ["{\"category\":"]],
    ["the settings: episodes not an object", `GET nl:pod:${POD}:public`, [show([] as unknown as Record<string, unknown>)]],
    ["the settings: episodes as text", `GET nl:pod:${POD}:public`, [JSON.stringify({ category: "Education", explicit: false, episodes: "{}" })]],
    ["the settings: over PUBLIC_SHOW_MAX_BYTES", `GET nl:pod:${POD}:public`, [show({}, { pad: "x".repeat(PUBLIC_SHOW_MAX_BYTES) })]],
    ["the podcast: a number", `GET nl:pod:${POD}`, [7]],
    ["the podcast: no reply", `GET nl:pod:${POD}`, []],
    ["the store's address: a number", `GET nl:store:handle:${HANDLE}`, [7]],
  ];
  for (const [what, command, reply] of bents) {
    forgetPublicFeeds();
    bend = (commands) => (commands.length === 1 && commands[0].map(String).join(" ") === command ? reply : undefined);
    const answer = await get(`${pid}.xml`);
    const body = await answer.text();
    bend = null;
    is(`${what}: 503 with Retry-After, no feed`, [answer.status, Boolean(answer.headers.get("retry-after")), body.includes("<rss"), answer.headers.get("cache-control")], [503, true, false, "no-store"]);
    sent.length = 0;
    const next = await get(`${pid}.xml`);
    is(`${what}: not kept, read again and answered`, [next.status, reads().some((c) => c.startsWith("GET nl:pod:"))], [200, true]);
  }

  part("Settings the feed cannot be written from give a 503, never a feed without them");
  for (const [what, text] of [
    ["a category that is not one", show({ ep0000000001: { visibility: "public", audio: AUDIO } }, { category: "Gossip" })],
    ["an explicit flag that is not yes or no", show({ ep0000000001: { visibility: "public", audio: AUDIO } }, { explicit: "no" })],
  ] as const) {
    forgetPublicFeeds();
    await writeShow(text);
    const answer = await get(`${pid}.xml`);
    is(`${what}: 503, no feed`, [answer.status, (await answer.text()).includes("<rss")], [503, false]);
  }
  await writeShow(SETTINGS);

  part("No public settings, a draft, a product that is not a podcast, a store that is not there: 404");
  forgetPublicFeeds();
  await writeShow(null);
  is("a podcast with no public settings", (await get(`${pid}.xml`)).status, 404);
  await writeShow(SETTINGS);
  forgetPublicFeeds();
  is("with its settings back, served", (await get(`${pid}.xml`)).status, 200);
  const plain = await addProduct(OWNER, "A plain download", "", "5", null);
  if (!plain.ok) throw new Error("no product");
  is("a product that is not a podcast", (await get(`${plain.product.id}.xml`)).status, 404);
  is("a product id that is not the store's", (await get("zzzzzzzzzzzz.xml")).status, 404);
  is("a store that is not there", (await get(`${pid}.xml`, {}, "nobodyhere")).status, 404);
  is("an address that cannot be a store's", (await get(`${pid}.xml`, {}, "a b")).status, 404);
  is("a product segment too long to be one", (await get("x".repeat(400))).status, 404);
  const hidden = await setProductHidden(OWNER, pid, true);
  forgetPublicFeeds();
  is("a draft (the product taken off its page)", [hidden.ok, (await get(`${pid}.xml`)).status], [true, 404]);
  await setProductHidden(OWNER, pid, false);
  forgetPublicFeeds();
  is("published again, served", (await get(`${pid}.xml`)).status, 200);
  is("the route's own 404 and 503 answers are never cached by anybody", (await get("zzzzzzzzzzzz.xml")).headers.get("cache-control"), "no-store");

  part("A store suspension refuses an uncached feed and outlives no cached feed's bound (review 6786812167)");
  forgetPublicFeeds();
  is("healthy control: a public feed can be cached", (await get(`${pid}.xml`)).status, 200);
  await noteTakedown(OWNER, null, true);
  const suspensionNow = Date.now;
  Date.now = () => suspensionNow() + (PUBLIC_FEED_CACHE_SECONDS + 1) * 1000;
  try {
    sent.length = 0;
    const stopped = await get(`${pid}.xml`, { "if-none-match": etag });
    is("a suspension outlives the cached XML and ETag: 404, no feed and no build",
      [stopped.status, (await stopped.text()).includes("<rss"), reads().some((c) => c.startsWith(`GET nl:pod:${POD}`))],
      [404, false, false]);
  } finally {
    Date.now = suspensionNow;
  }
  forgetPublicFeeds();
  before = await requestsIn(folder, window);
  const suspended = await get(`${pid}.xml`);
  is("an uncached suspension is refused before a hold or podcast read",
    [suspended.status, (await suspended.text()).includes("<rss"), (await requestsIn(folder, window)) - before],
    [404, false, 0]);
  await noteTakedown(OWNER, null, false);
  is("a restored store can serve its public feed again", (await get(`${pid}.xml`)).status, 200);

  part("The cache is bounded by entries and by bytes");
  forgetPublicFeeds();
  const big = "x".repeat(1000);
  for (let n = 0; n < PUBLIC_FEED_CACHE_ENTRIES + 50; n += 1) keepFeed(`k${n}`, { store, xml: big, etag: '"e"', bytes: 1000 }, Date.now());
  let held = 0;
  for (let n = 0; n < PUBLIC_FEED_CACHE_ENTRIES + 50; n += 1) if (cachedFeed(`k${n}`, Date.now())) held += 1;
  is("never more than PUBLIC_FEED_CACHE_ENTRIES, the oldest let go first", [held, Boolean(cachedFeed("k0", Date.now())), Boolean(cachedFeed(`k${PUBLIC_FEED_CACHE_ENTRIES + 49}`, Date.now()))], [PUBLIC_FEED_CACHE_ENTRIES, false, true]);
  forgetPublicFeeds();
  const huge = "y".repeat(PUBLIC_FEED_CACHE_BYTES / 4);
  for (let n = 0; n < 8; n += 1) keepFeed(`h${n}`, { store, xml: huge, etag: '"h"', bytes: huge.length }, Date.now());
  let total = 0;
  for (let n = 0; n < 8; n += 1) total += cachedFeed(`h${n}`, Date.now())?.bytes ?? 0;
  is("never more than PUBLIC_FEED_CACHE_BYTES held", total <= PUBLIC_FEED_CACHE_BYTES && total > 0, true);
  keepFeed("too-big", { store, xml: "z", etag: '"z"', bytes: PUBLIC_FEED_CACHE_BYTES + 1 }, Date.now());
  is("a feed larger than the whole cache is not kept (it is still sent, counted)", cachedFeed("too-big", Date.now()), null);
  forgetPublicFeeds();

  part("The units are priced above what the answer costs (MR: a ceiling before every spend)");
  const later = laterPageCost();
  // The heavy shape's CPU and memory for each megabyte worked through (as the registry's perMegabyte), its call counted too.
  const heavyPerByte = request("heavy", 0) / 1e6;
  const base = MAX_STORE_BYTES + MAX_PRODUCT_BYTES;
  const built = request("heavy", PUBLIC_FEED_READ_COMMANDS, base) + base * heavyPerByte;
  is(`a feed built's base: ${PUBLIC_FEED_BUILD_UNITS} units at $${later.toFixed(6)} cover $${built.toFixed(6)} (the call, the commands, the store and listing at their largest)`, PUBLIC_FEED_BUILD_UNITS * later >= built, true);
  const perRead = PUBLIC_FEED_BYTES_PER_UNIT * (DB_BYTE + heavyPerByte);
  is(`each unit of bytes read: $${later.toFixed(6)} covers $${perRead.toFixed(6)} (read from the database and worked through)`, later >= perRead, true);
  const largest = base + PODCAST_RECORD_MOST + PUBLIC_SHOW_MAX_BYTES;
  const worst = request("heavy", PUBLIC_FEED_READ_COMMANDS, largest) + largest * heavyPerByte;
  is(`the hold: ${PUBLIC_FEED_HOLD_UNITS} units cover a feed built at its worst, $${worst.toFixed(6)}`, PUBLIC_FEED_HOLD_UNITS * later >= worst, true);
  is("the hold is the base and the largest records' units", PUBLIC_FEED_HOLD_UNITS, buildUnits(PODCAST_RECORD_MOST + PUBLIC_SHOW_MAX_BYTES));
  const firstSent = request("light", 4) + 4 * COMMAND + PUBLIC_FEED_BYTES_PER_UNIT * (ORIGIN_PER_BYTE + heavyPerByte);
  is(`the first unit sent covers a kept feed's request and its first bytes, written and sent: $${firstSent.toFixed(6)}`, later >= firstSent, true);
  const perSent = PUBLIC_FEED_BYTES_PER_UNIT * (ORIGIN_PER_BYTE + heavyPerByte);
  is(`each further unit sent: $${later.toFixed(6)} covers $${perSent.toFixed(6)}`, later >= perSent, true);
  is("sendUnits: one at least, then one per PUBLIC_FEED_BYTES_PER_UNIT", [sendUnits(0), sendUnits(1), sendUnits(PUBLIC_FEED_BYTES_PER_UNIT), sendUnits(PUBLIC_FEED_BYTES_PER_UNIT + 1)], [1, 1, 1, 2]);
  is("sendUnits refuses a size that is not one", [sendUnits(-1), sendUnits(Number.NaN), sendUnits(1.5)], [null, null, null]);
  is("byteUnits: none for nothing, then one per PUBLIC_FEED_BYTES_PER_UNIT", [byteUnits(0), byteUnits(1), byteUnits(PUBLIC_FEED_BYTES_PER_UNIT + 1), byteUnits(-1)], [0, 1, 2, null]);

  part("A store's own page is /@handle: that @ names the store, not a person; an email anywhere is still refused");
  const feedWith = (page: string, audio = AUDIO) => {
    try {
      publicFeedXml({ title: "Tide", summary: "", author: "Tide", page, image: null, category: "Education", explicit: false, episodes: [{ episode: podcast().episodes[0], visibility: "public" }], audio: () => audio });
      return "written";
    } catch (error) {
      return error instanceof PublicFeedError ? error.reason : `other: ${String(error)}`;
    }
  };
  is("the store's product page, as every store page is written", feedWith(`https://marktmorgen.com/@${HANDLE}/p/tide-talks-weekly`), "written");
  is("an email in the page's query", feedWith(`https://marktmorgen.com/@${HANDLE}/p/x?to=dana@example.com`), "buyer-data");
  is("an email in the page's path", feedWith(`https://marktmorgen.com/@${HANDLE}/dana@example.com`), "buyer-data");
  is("an email written %40", feedWith(`https://marktmorgen.com/@${HANDLE}/p/x?to=dana%40example.com`), "buyer-data");
  is("an email right after a slash, %40 or not", [feedWith("https://marktmorgen.com/x/dana@example.com"), feedWith("https://marktmorgen.com/x/dana%40example.com")], ["buyer-data", "buyer-data"]);
  is("an @ in the audio address that is not a store page's", feedWith(`https://marktmorgen.com/@${HANDLE}/p/x`, "https://cdn.example.org/a@b.example/x.mp3"), "buyer-data");
  is("a token in the page, %-written or not", [feedWith(`https://marktmorgen.com/@${HANDLE}/${TOKEN}`), feedWith(`https://marktmorgen.com/@${HANDLE}/%66${"f".repeat(47)}`)], ["buyer-data", "buyer-data"]);
  is("an address whose %-escapes do not read", feedWith(`https://marktmorgen.com/@${HANDLE}/p/%E0%A4%A`), "buyer-data");

  part("The route never touches audio or the private feed");
  const source = readFileSync(join(process.cwd(), "app/api/store/podcast/public/[handle]/[product]/route.ts"), "utf8");
  is("no signed media, no file store, no fetch", [/signedMedia|@vercel\/blob|@\/lib\/blob|fetch\(/.test(source)], [false]);
  const hold = source.indexOf("holdPublicRequests(store, PUBLIC_FEED_HOLD_UNITS, now)");
  is("held before the podcast is read, and the bytes taken before the body is sent", hold > 0 && hold < source.indexOf("readPodcast(") && source.indexOf("sendUnits(feed.bytes)") < source.lastIndexOf("new Response(body"), true);
  is("held before the listing is read", hold > 0 && hold < source.indexOf("readListingExactly(store"), true);
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
