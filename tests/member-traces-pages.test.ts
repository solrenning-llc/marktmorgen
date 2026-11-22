/**
 * Issue #5125, row (1): the copy of a member's community activity (lib/community.ts memberTraces) read a whole
 * community from before the trace began (TRACED_SINCE) in one request: up to MAX_POSTS posts, every comment under
 * each and two SISMEMBERs a comment, about 6.03 million commands. The coordinator's decision (mail f6a9, 22 November
 * 2026): no incomplete copy; the copy goes in pages, at most COPY_PAGE_MAX_COMMANDS commands a request, with a cursor
 * the person uses on the next request until the copy is complete, and the union of the pages is exactly what reading
 * the whole community finds.
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { SCAN_POST_MOST_COMMANDS, TRACE_PAGE_START_COMMANDS, TRACE_SCAN_MOST, addComment, createPost, deletePost, memberTraces, memberTracesPage, readPost, toggleCommentLike, toggleLike } from "@/lib/community";
import { vote, votesOf } from "@/lib/community-polls";
import { COPY_PAGE_MAX_COMMANDS, ReadBudget } from "@/lib/copy-pages";
import { TRACED_SINCE, traceKey } from "@/lib/community-trace";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "pagesowner@example.com";
const realNow = Date.now;
const realPipeline = redis.pipeline.bind(redis);

let commands = 0;
function counting(): void {
  commands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return realPipeline(batch);
  }) as typeof redis.pipeline;
}
const stopCounting = () => (redis.pipeline = realPipeline as typeof redis.pipeline);

const key = (who: number) => `member${String(who).padStart(26, "0")}`;


const sorted = (list: unknown[]) => list.map((x) => JSON.stringify(x)).sort();

/** Reads every page in turn, counting each page's commands; `between` runs after each page but the last. */
async function readAll(id: string, who: string, between?: () => Promise<void>, sscan?: (cmd: (string | number)[]) => unknown) {
  const got = { posts: [] as unknown[], comments: [] as unknown[], likedPosts: [] as unknown[], likedComments: [] as unknown[], reported: [] as unknown[], pollPosts: [] as unknown[] };
  const votes: unknown[] = [];
  let resume: string | undefined;
  let pages = 0;
  let largest = 0;
  do {
    commands = 0;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      commands += batch.length;
      if (sscan && batch.some((c) => c[0] === "SSCAN")) return batch.map((c) => (c[0] === "SSCAN" ? sscan(c) : redis.run(c as string[])));
      return realPipeline(batch);
    }) as typeof redis.pipeline;
    let page;
    try {
      page = await memberTracesPage(id, who, new ReadBudget(COPY_PAGE_MAX_COMMANDS), resume);
    } finally {
      stopCounting();
    }
    largest = Math.max(largest, commands);
    pages++;
    for (const k of Object.keys(got) as (keyof typeof got)[]) got[k].push(...page.traces[k]);
    votes.push(...page.votes);
    resume = page.resume;
    if (resume !== undefined && between) await between();
  } while (resume !== undefined && pages < 1_000);
  return { got, votes, pages, largest, ended: resume === undefined };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pagesshop", "Pages Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Page00001", subscriptionId: "sub_Page00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const ada = key(1);

  // A community from before the trace began: its posts are older than TRACED_SINCE, so the copy cannot read her
  // trace alone. Enough posts and comments that the whole read takes more than one page.
  Date.now = () => (TRACED_SINCE - 30 * 86_400) * 1000;
  const posts: string[] = [];
  const POSTS = Math.ceil(COPY_PAGE_MAX_COMMANDS / 5) + 7;
  for (let n = 0; n < POSTS; n++) {
    const made = await createPost(id, { space: "", author: n % 3 === 0 ? ada : key(2 + n), title: `Post ${n}`, text: `Text ${n}`, img: null, kind: "post", poll: null }, store);
    if (!made.ok) throw new Error(`post ${n} not made`);
    posts.push(made.post.id);
    const c = await addComment(id, made.post.id, { parent: "", author: n % 2 === 0 ? ada : key(3 + n), text: `Comment ${n}` }, store);
    if (!c.ok) throw new Error(`comment ${n} not made`);
    if (n % 5 === 0) await toggleLike(id, made.post.id, ada, store);
    if (n % 7 === 0) await toggleCommentLike(id, made.post.id, c.comment.id, ada, store);
  }

  const poll = { options: [{ id: "1", text: "Yes" }, { id: "2", text: "No" }], multi: false, ends: 0, quiet: false };
  const polled = await createPost(id, { space: "", author: key(5), title: "Vote", text: "Which?", img: null, kind: "post", poll }, store);
  if (!polled.ok) throw new Error("no poll post");
  await vote(id, polled.post.id, poll, ada, ["2"], store);

  part("The whole read, as before, is more than one page");
  counting();
  const whole = await memberTraces(id, ada);
  stopCounting();
  is(`the whole community read takes more than ${COPY_PAGE_MAX_COMMANDS} commands (${commands})`, commands > COPY_PAGE_MAX_COMMANDS, true);

  part("Every page makes progress: a fresh page always has room for its start and one whole post, or one trace reply");
  is("the largest post fits a fresh page", TRACE_PAGE_START_COMMANDS + 1 + 2 * 500 + SCAN_POST_MOST_COMMANDS <= COPY_PAGE_MAX_COMMANDS, true);
  is("one SSCAN reply at its most fits a fresh page", TRACE_PAGE_START_COMMANDS + 1 + TRACE_SCAN_MOST <= COPY_PAGE_MAX_COMMANDS, true);

  part("Each page stays under the bound, and the pages together are the whole read");
  const wholeVotes = await votesOf(id, ada, whole.pollPosts);
  is("she voted in a poll, so the votes are part of it", wholeVotes.length, 1);
  const read = await readAll(id, ada);
  is(`no page spent more than ${COPY_PAGE_MAX_COMMANDS} commands (largest ${read.largest})`, read.largest <= COPY_PAGE_MAX_COMMANDS, true);
  is(`it took more than one page (${read.pages})`, read.pages > 1, true);
  is("and it ended", read.ended, true);
  for (const k of Object.keys(read.got) as (keyof typeof read.got)[]) is(`${k}: the pages hold exactly the whole read`, sorted(read.got[k]), sorted(whole[k]));
  is("votes: the pages hold exactly the whole read", sorted(read.votes), sorted(wholeVotes));

  part("Posted and deleted between pages: what was kept the whole time is read once, on some page");
  const ids = posts.slice();
  let between = 0;
  const changed = await readAll(id, ada, async () => {
    between++;
    if (between === 1) {
      // A newer post, and one of hers deleted that the first page has not reached yet (the oldest).
      Date.now = () => (TRACED_SINCE - 29 * 86_400) * 1000;
      const late = await createPost(id, { space: "", author: ada, title: "Late", text: "Posted between pages", img: null, kind: "post", poll: null }, store);
      if (!late.ok) throw new Error("late post not made");
      const gone = await readPost(id, ids[0]!);
      if (!gone) throw new Error("oldest post missing");
      await deletePost(id, gone, store);
    }
  });
  const keptThroughout = whole.posts.map((p) => (p as { post: string }).post).filter((post) => post !== ids[0]);
  const seen = (changed.got.posts as { post: string }[]).map((p) => p.post);
  is("every post of hers kept the whole time is in the pages", keptThroughout.every((post) => seen.includes(post)), true);
  is("and none twice", new Set(seen).size, seen.length);
  is("the deleted one's comments are not counted twice either", new Set((changed.got.comments as { comment: string }[]).map((c) => c.comment)).size, changed.got.comments.length);

  part("A community begun after the trace: her trace, SSCAN by SSCAN, in pages");
  redis.clear();
  await claimHandle(OWNER, "pagesshop", "Pages Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Page00001", subscriptionId: "sub_Page00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const later = (await storeForEmail(OWNER))!;
  const lid = later.community!.id;
  Date.now = () => (TRACED_SINCE + 86_400) * 1000;
  const real = await createPost(lid, { space: "", author: ada, title: "Mine", text: "After the trace", img: null, kind: "post", poll: null }, later);
  if (!real.ok) throw new Error("no post");
  const liked = await createPost(lid, { space: "", author: key(9), title: "Theirs", text: "Liked", img: null, kind: "post", poll: null }, later);
  if (!liked.ok) throw new Error("no post");
  await toggleLike(lid, liked.post.id, ada, later);
  // References to likes of posts that are gone, as a long-kept trace holds, enough for more than one page.
  const REFS = COPY_PAGE_MAX_COMMANDS + 1_000;
  for (let n = 0; n < REFS; n += 500) redis.run(["SADD", traceKey(lid, ada), ...Array.from({ length: Math.min(500, REFS - n) }, (_, k) => `l:gone${String(n + k).padStart(20, "0")}`)]);
  const trace = traceKey(lid, ada);
  const wholeTrace = await memberTraces(lid, ada);
  const pagedScan = (count: number) => (cmd: (string | number)[]) => {
    // Redis's SSCAN, COUNT at a time from its cursor, for this set: the stand-in answers every member at once.
    const members = (redis.run(["SMEMBERS", trace]) as string[]).sort();
    const from = Number(cmd[2]);
    const next = from + count >= members.length ? "0" : String(from + count);
    return [next, members.slice(from, from + count)];
  };
  const tracePages = await readAll(lid, ada, undefined, pagedScan(100));
  is(`no trace page spent more than ${COPY_PAGE_MAX_COMMANDS} commands (largest ${tracePages.largest})`, tracePages.largest <= COPY_PAGE_MAX_COMMANDS, true);
  is(`it took more than one page (${tracePages.pages})`, tracePages.pages > 1, true);
  for (const k of Object.keys(tracePages.got) as (keyof typeof tracePages.got)[]) is(`trace ${k}: the pages hold exactly the whole read`, sorted(tracePages.got[k]), sorted(wholeTrace[k]));

  part("An SSCAN reply larger than the page reserved for it is unknown: the copy is made again, never read past its bound");
  let refused = "";
  try {
    await readAll(lid, ada, undefined, pagedScan(TRACE_SCAN_MOST + 1));
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  is("refused", /community trace/.test(refused), true);

  Date.now = realNow;
  done();
}

main().catch((error) => {
  Date.now = realNow;
  stopCounting();
  console.error(error);
  process.exit(1);
});
