/**
 * An episode asked for with a feed token whose access has ended (audit of private podcasts, 9 November 2026, M1 and M2).
 *
 * app/api/store/podcast/play/[token]/[episode]/route.ts read the grant, the store and the product and asked mayListen
 * (Stripe, through holdsProducts, with a "no" kept for 60 seconds) BEFORE it took the store's public request: on the
 * refusal (403) nothing was ever charged, so 600 requests an hour on one dead token spent 3,660 Redis commands and 60
 * Stripe calls that nobody paid for, and anyone can make such a token by subscribing and canceling. And the episode was
 * handed out as a signed R2 address that worked for four hours, any number of times.
 *
 * What holds now:
 *   - the store's public request is taken before the access is asked;
 *   - a confirmed "no" deletes the token's grant (its index stays, so the same address opens again for the buyer the
 *     next time a feed is handed to them with access): every later request is one read that answers 404;
 *   - Stripe that cannot be asked is not a "no": 503, try again, and the grant stays;
 *   - the signed address of an episode works for minutes; the app asks our address again for a new one.
 *
 * Synthetic only: the in-memory Redis double and a local stand-in for Stripe.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as play } from "@/app/api/store/podcast/play/[token]/[episode]/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPastBuyers, setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { newPodcastId, savePodcast } from "@/lib/podcast";
import { feedToken, readFeedToken } from "@/lib/podcast-access";
import { grantImported } from "@/lib/imported-purchases";
import { PLAY_COMMANDS, PLAY_REQUEST_UNITS } from "@/lib/podcast-rules";
import { REQUEST_COMMANDS } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "podcast-play-charged@example.com";
const BUYER = "refunded.listener@example.com";
const OTHER = "unknown.listener@example.com";

/** What happened, in order: a public request taken ("charge") or a call to Stripe ("stripe"). */
const events: string[] = [];
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    events.push("stripe");
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
let commands = 0;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  if (batch.some((c) => c.some((x) => typeof x === "string" && x.startsWith("nl:traffic:")))) events.push("charge");
  return original(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_podcast_play_only";
  process.env.R2_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  process.env.R2_ACCESS_KEY_ID = "AKIATESTSONLY000000";
  process.env.R2_SECRET_ACCESS_KEY = "tests-only-secret-tests-only-secret-0000";
  process.env.R2_BUCKET = "tests-bucket";
  await claimHandle(OWNER, "podplaycharged", "Pod Play Charged", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1PodPlayCharged01", true);
  await setSubscription(OWNER, { customerId: "cus_PodPlayCharged", subscriptionId: "sub_PodPlayCharged", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Members Radio", "", "19");
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const podcastId = newPodcastId();
  if (!(await setProductPodcast(OWNER, id, { id: podcastId, episodes: 0 })).ok) throw new Error("not a podcast");
  await savePodcast({ id: podcastId, episodes: [{ id: "aaaaaaaaaaa1", title: "One", notes: "", pathname: "vault/0123456789abcdef0123456789abcdef/abcdefghij12/one.mp3", bytes: 1000, contentType: "audio/mpeg", at: 1 }] });
  await setPodcastEpisodes(OWNER, id, 1);
  const store = (await storeForEmail(OWNER))!;
  const ownToken = (await feedToken(store, id, OWNER))!;
  // Feeds made while they held the podcast; Stripe now finds nothing they hold (refunded in full, say).
  const deadToken = (await feedToken(store, id, BUYER))!;
  const unsureToken = (await feedToken(store, id, OTHER))!;
  const ask = (token: string) => play(new NextRequest(`https://marktmorgen.com/api/store/podcast/play/${token}/aaaaaaaaaaa1.mp3`), { params: Promise.resolve({ token, episode: "aaaaaaaaaaa1.mp3" }) });

  part("The creator's own feed: charged, and handed an address that works for minutes");
  events.length = 0;
  commands = 0;
  const own = await ask(ownToken);
  is("its commands within PLAY_COMMANDS and its units' counting", commands <= PLAY_COMMANDS + PLAY_REQUEST_UNITS * REQUEST_COMMANDS, true);
  console.log(`        the creator's own episode: ${commands} Redis commands`);
  is("sent on to the file (302)", own.status, 302);
  is("the store's public request was taken", events.includes("charge"), true);
  const location = new URL(own.headers.get("Location") ?? "https://none.invalid/");
  is("a signed R2 address", location.hostname.endsWith(".r2.cloudflarestorage.com"), true);
  const expires = Number(location.searchParams.get("X-Amz-Expires"));
  is("valid for ten minutes at the most, not four hours", expires > 0 && expires <= 10 * 60, true);
  // The R2 reads that address brings are priced in what an episode takes (tests/plan-cost-registry.ts, held in its test).
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the cost registry prices an episode's R2 Class B reads", /PODCAST_PLAY_READ[\s\S]*R2_CLASS_B/.test(registry), true);

  part("A buyer who holds it (brought over from another platform), the access asked afresh: the heaviest answer");
  const HOLDER = "brought.over@example.com";
  await setPastBuyers(OWNER);
  const importing = (await storeForEmail(OWNER))!;
  await grantImported(importing.statsId!, "a".repeat(24), [{ email: HOLDER, productId: id, items: null }], Math.floor(Date.now() / 1000), importing.sid);
  const holderToken = (await feedToken(importing, id, HOLDER))!;
  events.length = 0;
  commands = 0;
  const held = await ask(holderToken);
  is("sent on to the file (302)", held.status, 302);
  is("charged before anything else is asked", events[0], "charge");
  is("its commands within PLAY_COMMANDS and its units' counting", commands <= PLAY_COMMANDS + PLAY_REQUEST_UNITS * REQUEST_COMMANDS, true);
  console.log(`        a buyer's episode, access asked afresh: ${commands} Redis commands, ${events.filter((e) => e === "stripe").length} Stripe call(s)`);

  part("A dead token: the first request is charged before Stripe is asked, and the confirmed no ends the token");
  events.length = 0;
  commands = 0;
  const first = await ask(deadToken);
  const firstCommands = commands;
  is("refused (403)", first.status, 403);
  is("charged", events.includes("charge"), true);
  is("charged before Stripe is asked", events.indexOf("charge") >= 0 && events.indexOf("charge") < events.indexOf("stripe"), true);
  const stripeOnFirst = events.filter((e) => e === "stripe").length;
  is("its commands within PLAY_COMMANDS and its units' counting", firstCommands <= PLAY_COMMANDS + PLAY_REQUEST_UNITS * REQUEST_COMMANDS, true);
  is("its grant is gone", await readFeedToken(deadToken), null);

  part("The same token asked 599 more times over the hour");
  events.length = 0;
  commands = 0;
  let notFound = 0;
  for (let i = 0; i < 599; i++) {
    const r = await ask(deadToken);
    if (r.status === 404) notFound += 1;
    redis.advance(6_000);
  }
  is("each answered 404", notFound, 599);
  is("Stripe is never asked again", events.filter((e) => e === "stripe").length, 0);
  is("one read each, no more", commands <= 599, true);
  console.log(`        first request: ${firstCommands} Redis commands, ${stripeOnFirst} Stripe call(s); the 599 after it: ${commands} Redis commands`);

  part("The buyer's own address opens again when a feed is handed to them with access");
  const again = await feedToken(store, id, BUYER);
  is("the same address", again, deadToken);
  is("its grant is back", (await readFeedToken(deadToken))?.e, BUYER);

  part("Stripe that cannot be asked is not a no");
  stripeDown = true;
  redis.advance(120_000);
  events.length = 0;
  const unsure = await ask(unsureToken);
  is("503, to try again", unsure.status, 503);
  is("with Retry-After", unsure.headers.has("Retry-After"), true);
  is("kept by nobody", unsure.headers.get("Cache-Control"), "private, no-store");
  is("charged", events.includes("charge"), true);
  is("its grant stays", (await readFeedToken(unsureToken))?.e, OTHER);
  stripeDown = false;
  done();
}

void main();
