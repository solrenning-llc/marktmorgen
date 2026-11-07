/**
 * 233 [SK1], #3016 review (Codex K2): the About page's post count reads only
 * the newest ABOUT_POSTS_READ posts, so what it says must stay true of what
 * that window can and cannot know. Against the in-memory Redis double and a
 * synthetic store only; nothing is sent anywhere.
 *
 *   1. A full window of recent posts that are all hidden says nothing about
 *      the older recent posts past it: the count is unknown, so the page
 *      leaves the posts line out (never "No posts in the last 30 days"), and
 *      the kept counts read back the same way. No language says "no posts"
 *      for a lower bound.
 *   2. A post's time in the future, or one that is not a whole number
 *      (JSON 1e309 parses as Infinity), is not a post in the last 30 days:
 *      the count is unknown and left out, not counted.
 *   3. A feed reply longer than the ABOUT_POSTS_READ asked for is off-shape:
 *      the count is unknown and no post read goes past the declared window.
 *   4. Controls: an empty feed is a real zero, one visible recent post is
 *      one, and a full window of visible recent posts is "at least" that;
 *      "at least 1" is said in the singular.
 */
import { renderToStaticMarkup } from "react-dom/server";
import Page from "@/app/[handle]/community/about/page";
import { claimHandle, ensureStatsId, setCommunity, setStripeAccount, setSubscription } from "@/lib/store";
import { freshConfig, readConfig, saveConfig } from "@/lib/community";
import { ABOUT_POSTS_READ, aboutCounts, aboutWords } from "@/lib/community-about";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sk1_about_window";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let sent: (string | number)[][] = [];
let feedReply: string[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const replies = await real(commands);
  return commands.map((c, i) => (feedReply && c[0] === "ZREVRANGE" ? feedReply : replies[i]));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "sk1window@example.com";
  await claimHandle(OWNER, "sk1window", "Window Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_sk1window0000", true);
  await setSubscription(OWNER, { customerId: "cus_sk1window", subscriptionId: "sub_sk1window", active: true, tier: "creator", period: paidPeriod() } as never);
  const store = (await setCommunity(OWNER, true))!;
  const id = store.community!.id;
  await saveConfig(id, { ...freshConfig(store.name), about: "Synthetic public description.", page: { on: true, counts: true } });
  const config = (await readConfig(id))!;
  const at = Math.floor(Date.now() / 1000);

  /** Puts the feed back to these posts, newest first, and forgets the kept counts. */
  const feed = async (posts: { at: unknown; hid: boolean }[], raw?: string[]) => {
    await redis.pipeline([["DEL", `nl:cm:${id}:feed`, `nl:cm:${id}:about`]]);
    for (let i = 0; i < posts.length; i += 1) {
      const pid = `w${String(i).padStart(23, "0")}`;
      await redis.pipeline([
        ["SET", `nl:cm:${id}:p:${pid}`, raw?.[i] ?? JSON.stringify({ ...posts[i], title: "PRIVATE_POST_WORDS" })],
        ["ZADD", `nl:cm:${id}:feed`, at - i, pid],
      ]);
    }
  };
  const widestRead = () => Math.max(0, ...sent.filter((c) => c[0] === "MGET").map((c) => c.length - 1));

  part("1. A window of hidden posts is not a confirmed zero");
  // The newest ABOUT_POSTS_READ are recent and hidden; one older recent post is visible.
  await feed(Array.from({ length: ABOUT_POSTS_READ + 1 }, (_, i) => ({ at: at - 60 - i, hid: i < ABOUT_POSTS_READ })));
  sent = [];
  const hidden = await aboutCounts(store, id, config);
  is("the posts count is unknown, left out (not 0)", hidden?.posts ?? "omitted", "omitted");
  is("the joined count is still shown", hidden?.joined, 0);
  sent = [];
  const keptBack = await aboutCounts(store, id, config);
  is("kept and read back the same way, with no feed read again", [keptBack?.posts ?? "omitted", sent.some((c) => c[0] === "ZREVRANGE")], ["omitted", false]);
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ handle: "@sk1window" }) }));
  is("the page renders the creator's description", html.includes("Synthetic public description."), true);
  is("the page never says there were no posts", html.includes(aboutWords("en").posts(0, false)), false);
  is("no post's words on the page", html.includes("PRIVATE_POST_WORDS"), false);
  is(
    "no language says \"no posts\" for a lower bound",
    LANGUAGE_CODES.filter((l) => aboutWords(l).posts(0, true) === aboutWords(l).posts(0, false)),
    [],
  );

  part("2. A time in the future or not a whole number is unknown");
  await feed([{ at: at + 3_600, hid: false }]);
  is("a post an hour in the future: unknown, not counted", (await aboutCounts(store, id, config))?.posts ?? "omitted", "omitted");
  is("nothing kept", (await redis.pipeline([["EXISTS", `nl:cm:${id}:about`]]))[0], 0);
  await feed([{ at: 0, hid: false }], ['{"at":1e309,"hid":false}']);
  is("a time of 1e309 (Infinity): unknown, not counted", (await aboutCounts(store, id, config))?.posts ?? "omitted", "omitted");
  await feed([{ at: 0, hid: false }], ['{"at":1712345678.5,"hid":false}']);
  is("a time that is not a whole number of seconds: unknown", (await aboutCounts(store, id, config))?.posts ?? "omitted", "omitted");

  part("3. A feed reply wider than asked for is off-shape");
  const wide = Array.from({ length: ABOUT_POSTS_READ + 5 }, (_, i) => ({ at: at - 60 - i, hid: false }));
  await feed(wide);
  const ids = (await redis.pipeline([["ZREVRANGE", `nl:cm:${id}:feed`, 0, -1]]))[0] as string[];
  feedReply = ids;
  sent = [];
  const tooWide = await aboutCounts(store, id, config);
  feedReply = null;
  is(`a reply of ${ids.length} ids for ${ABOUT_POSTS_READ} asked: posts unknown`, tooWide?.posts ?? "omitted", "omitted");
  is(`no post read past the ${ABOUT_POSTS_READ}-post window`, widestRead() <= ABOUT_POSTS_READ, true);

  part("4. Controls");
  await feed([]);
  is("an empty feed: a real zero", (await aboutCounts(store, id, config))?.posts, { n: 0, atLeast: false });
  await feed([{ at: at - 60, hid: false }]);
  is("one visible recent post: one", (await aboutCounts(store, id, config))?.posts, { n: 1, atLeast: false });
  await feed([{ at: at - 60, hid: false }, { at: at - 61, hid: true }, { at: at - 40 * 86_400, hid: false }]);
  is("a hidden and an old post are not counted, and the count is exact", (await aboutCounts(store, id, config))?.posts, { n: 1, atLeast: false });
  await feed(Array.from({ length: ABOUT_POSTS_READ }, (_, i) => ({ at: at - 60 - i, hid: false })));
  is(`a full window of visible recent posts: at least ${ABOUT_POSTS_READ}`, (await aboutCounts(store, id, config))?.posts, { n: ABOUT_POSTS_READ, atLeast: true });
  await feed(Array.from({ length: ABOUT_POSTS_READ }, (_, i) => ({ at: at - 60 - i, hid: i > 0 })));
  is("a full window with one visible post: at least 1", (await aboutCounts(store, id, config))?.posts, { n: 1, atLeast: true });
  is("the words for at least 1 are singular", aboutWords("en").posts(1, true), "At least 1 post in the last 30 days");
  done();
}
main();
