/**
 * 233 [SK1]: a community's public About page (app/[handle]/community/about,
 * lib/community-about.ts), against the in-memory Redis double and synthetic
 * stores only. Nothing is sent to Stripe: the checks read what the store
 * record already says about its account.
 *
 *   1. Off by default: a new community, and one written down before the page
 *      existed, has it off; a page that is off, a community switched off or
 *      a store with no community is not found.
 *   2. On, without counts: the creator's name and description, and only the
 *      products that open it and are on sale now (a draft is not shown), each
 *      with its published price and how many spaces it opens. No member,
 *      feed or post is read.
 *   3. With counts: how many people have joined and how many posts were
 *      written in the last 30 days, as they are, small numbers included; no
 *      member's name or address and no post's words are in what the page
 *      draws. The counts are kept and read back, not worked out again.
 *   4. A count that cannot be read is left out, never shown as 0, and is not
 *      kept; a refresh the store's requests refuse reads nothing and shows no
 *      counts.
 *   5. Its cost: the refresh's requests cover what it reads at a later page's
 *      price; the page is counted (isResting) before the products are read.
 *   6. The creator turns it on and off from the studio (manage route action
 *      "about-page").
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/community/manage/route";
import { addProduct, claimHandle, ensureStatsId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { createPost, freshConfig, readConfig, saveConfig, setPostHidden } from "@/lib/community";
import { NO_ABOUT_PAGE, parseAboutSetting } from "@/lib/community-about-setting";
import {
  ABOUT_POSTS_READ,
  ABOUT_REFRESH_BYTES,
  ABOUT_REFRESH_COMMANDS,
  ABOUT_REFRESH_UNITS,
  aboutCounts,
  aboutPage,
  aboutWords,
} from "@/lib/community-about";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { takePublicRequest } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { TAKE_COMMANDS, request, walkRead } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sk1_about_only";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
let sent: (string | number)[][] = [];
let spoil: "none" | "hlen" | "mget" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const replies = await real(commands);
  return commands.map((c, i) => {
    if (spoil === "hlen" && c[0] === "HLEN") return "QUEUED";
    if (spoil === "mget" && c[0] === "MGET") return "QUEUED";
    return replies[i];
  });
}) as typeof redis.pipeline;
const names = () => sent.map((c) => `${c[0]} ${String(c[1] ?? "")}`);

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "sk1about@example.com";
  await claimHandle(OWNER, "sk1about", "Bread Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_sk1about000", true);
  await setSubscription(OWNER, { customerId: "cus_sk1aboutshop", subscriptionId: "sub_sk1aboutshop", active: true, tier: "creator", period: paidPeriod() } as never);
  const paid = await addProduct(OWNER, "Bread Club Membership", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  const draft = await addProduct(OWNER, "Secret Draft Tier", "", "90", null, null, true);
  if (!paid.ok || !draft.ok) throw new Error("no products");
  await setProductLink(OWNER, paid.product.id, "https://example.com/club");
  await setProductLink(OWNER, draft.product.id, "https://example.com/draft");

  part("1. Off by default");
  is("a new community's About page is off, counts off", freshConfig("Bread Club").page, { on: false, counts: false });
  is("NO_ABOUT_PAGE is off", NO_ABOUT_PAGE, { on: false, counts: false });
  is("a setting written before the page existed reads as off", [parseAboutSetting(undefined), parseAboutSetting("yes"), parseAboutSetting({ on: "true", counts: 1 })], [NO_ABOUT_PAGE, NO_ABOUT_PAGE, NO_ABOUT_PAGE]);
  is("counts only with the page on", parseAboutSetting({ on: false, counts: true }), { on: false, counts: false });
  let store = (await storeForEmail(OWNER))!;
  is("a store with no community: not found", (await aboutPage(store)).state, "none");
  store = (await setCommunity(OWNER, true))!;
  const id = store.community!.id;
  const config = freshConfig(store.name);
  const wins = { id: "a1b2c3d4e5f6", name: "Wins", about: "", creatorOnly: false, only: [draft.product.id], level: 0 };
  await saveConfig(id, { ...config, about: "Weekly bakes and answers from me.", access: [paid.product.id, draft.product.id], spaces: [...config.spaces, wins] });
  is("an old setup without the field reads as off", (await readConfig(id))!.page, NO_ABOUT_PAGE);
  is("the page is off: not found", (await aboutPage(store)).state, "none");

  part("2. On, without counts");
  await saveConfig(id, { ...(await readConfig(id))!, page: { on: true, counts: false } });
  sent = [];
  const plain = await aboutPage(store);
  is("shown", plain.state, "shown");
  if (plain.state !== "shown") throw new Error("not shown");
  is("the creator's name and words", [plain.page.name, plain.page.about], ["Bread Club Community", "Weekly bakes and answers from me."]);
  is("only the product on sale now (no draft)", plain.page.ways.map((w) => w.title), ["Bread Club Membership"]);
  is("its published price, as the community's door says it", plain.page.ways[0].kind, "Membership · $20 a month");
  is("it goes to the product's own page, the checkout's door", plain.page.ways[0].href.startsWith(`/@sk1about/p/`), true);
  is("it opens the one space not kept for another product, of two", [plain.page.ways[0].spaces, plain.page.spaces], [1, 2]);
  is("no counts", plain.page.counts, null);
  is("no member, feed or post read", names().filter((n) => /:m$|:feed$|^MGET nl:cm:|:p:/.test(n)), []);
  store = (await setCommunity(OWNER, false))!;
  is("the community switched off: not found", (await aboutPage(store)).state, "none");
  store = (await setCommunity(OWNER, true))!;

  part("3. With counts");
  await saveConfig(id, { ...(await readConfig(id))!, page: { on: true, counts: true } });
  const member = (k: string, n: string, e: string) => JSON.stringify({ k, e, n, h: "", dir: true, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] });
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, "a".repeat(32), member("a".repeat(32), "Jane Hidden-Name", "jane@example.com"), "b".repeat(32), member("b".repeat(32), "", "bob@example.com")]]);
  const space = (await readConfig(id))!.spaces[0].id;
  const write = async (title: string) => {
    const made = await createPost(id, { space, author: "a".repeat(32), title, text: `${title} words`, img: null, kind: "post", poll: null }, store);
    if (!made.ok) throw new Error("no post");
    return made.post;
  };
  const old = await write("An old thread");
  await redis.pipeline([["SET", `nl:cm:${id}:p:${old.id}`, JSON.stringify({ ...old, at: Math.floor(Date.now() / 1000) - 40 * 86_400 })]]);
  await write("Week 4: the $40k month spreadsheet");
  const hidden = await write("Hidden by the creator");
  await setPostHidden(id, hidden, true);
  await write("Sourdough timing");
  sent = [];
  const counted = await aboutPage(store);
  if (counted.state !== "shown") throw new Error("not shown");
  is("two people joined; two posts in 30 days (the hidden and the old one not counted)", counted.page.counts && [counted.page.counts.joined, counted.page.counts.posts], [2, { n: 2, atLeast: false }]);
  const drawn = JSON.stringify(counted.page);
  is("no member's name or address, no post's words", ["Jane Hidden-Name", "jane@example.com", "bob@example.com", "spreadsheet", "Sourdough", "Secret Draft"].filter((s) => drawn.includes(s)), []);
  sent = [];
  const again = await aboutPage(store);
  is("kept: read back with no member or feed read", [again.state === "shown" && again.page.counts?.joined, names().filter((n) => /^HLEN|^ZREVRANGE|^MGET nl:cm:/.test(n))], [2, []]);

  part("3. Many posts: shown as at least what was read");
  for (let i = 0; i < ABOUT_POSTS_READ; i += 1) await write(`Thread ${i}`);
  await redis.pipeline([["DEL", `nl:cm:${id}:about`]]);
  const many = await aboutCounts(store, id, (await readConfig(id))!);
  is(`at least ${ABOUT_POSTS_READ}`, many?.posts, { n: ABOUT_POSTS_READ, atLeast: true });

  part("4. Unknown is left out, never 0, and not kept");
  await redis.pipeline([["DEL", `nl:cm:${id}:about`]]);
  spoil = "hlen";
  const noJoined = await aboutCounts(store, id, (await readConfig(id))!);
  spoil = "none";
  is("joined left out, posts still real", [noJoined?.joined ?? "omitted", noJoined?.posts?.n], ["omitted", ABOUT_POSTS_READ]);
  is("nothing kept", (await redis.pipeline([["EXISTS", `nl:cm:${id}:about`]]))[0], 0);
  spoil = "mget";
  const noPosts = await aboutCounts(store, id, (await readConfig(id))!);
  spoil = "none";
  is("posts left out, joined real", [noPosts?.posts ?? "omitted", noPosts?.joined], ["omitted", 2]);
  sent = [];
  await takePublicRequest(store, "buyer", Date.now(), requestLimitFor(store));
  is("(the store's requests used up)", await takePublicRequest(store, "public", Date.now(), 1), false);
  sent = [];
  const refused = await aboutCounts(store, id, (await readConfig(id))!);
  is("refused by the store's requests: no counts, nothing read", [refused, names().filter((n) => /^HLEN|^ZREVRANGE|^MGET nl:cm:/.test(n))], [null, []]);
  is("the words never print a missing count as 0", aboutWords("en").joined(0), "Nobody has joined yet");

  part("5. Cost");
  const refresh = request("heavy", ABOUT_REFRESH_COMMANDS + TAKE_COMMANDS, ABOUT_REFRESH_BYTES) + walkRead(0, ABOUT_REFRESH_BYTES);
  is("the refresh's requests cover what it reads, and one fewer would not", [ABOUT_REFRESH_UNITS * laterPageCost() >= refresh, (ABOUT_REFRESH_UNITS - 1) * laterPageCost() < refresh], [true, true]);
  console.log(`About page counts refreshed: $${refresh.toFixed(6)} at most, counted as ${ABOUT_REFRESH_UNITS} requests at $${laterPageCost().toFixed(6)}, at most every few hours`);
  const lib = readFileSync("lib/community-about.ts", "utf8");
  is("counted before the products are read", lib.indexOf("isResting(store") > 0 && lib.indexOf("isResting(store") < lib.indexOf("readListings("), true);
  const page = readFileSync("app/[handle]/community/about/page.tsx", "utf8");
  is("the page is not found while off", page.includes("notFound()"), true);
  is("every language has the words", LANGUAGE_CODES.map((l) => typeof aboutWords(l).joined(3)), LANGUAGE_CODES.map(() => "string"));

  part("6. The creator turns it on and off");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return { status: response.status, ...((await response.json()) as { ok: boolean }) };
  };
  is("off", [(await call({ action: "about-page", on: false, counts: true })).ok, (await readConfig(id))!.page], [true, { on: false, counts: false }]);
  is("on, without counts", [(await call({ action: "about-page", on: true, counts: false })).ok, (await readConfig(id))!.page], [true, { on: true, counts: false }]);
  is("the studio offers it", readFileSync("components/community-studio.tsx", "utf8").includes('action: "about-page"'), true);
  done();
}
main();
