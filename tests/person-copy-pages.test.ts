/**
 * Issue #5125, row (1), the copy in pages (lib/copy-pages.ts; the coordinator's decision, mail f6a9 and 7cdf,
 * 22 November 2026): a member whose community activity takes more than one request gets a copy whose first page says
 * there is more and carries a cursor; the cursor, sealed to the store and the address, reads the next page, until the
 * last says the copy is complete. A cursor for another person, changed by hand or for another module reads nothing of
 * theirs: the copy starts again from its first page. With no key to seal the cursor, none is sealed or opened (a
 * copy with more to read then fails rather than stop short; with no key, the store's Stripe read fails first).
 */
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_pages_only";
import { normaliseEmail } from "@/lib/auth";
import { createPost, addComment, memberTraces } from "@/lib/community";
import { COPY_PAGE_MAX_COMMANDS, openCursor, sealCursor } from "@/lib/copy-pages";
import { TRACED_SINCE } from "@/lib/community-trace";
import { emailKey } from "@/lib/learn";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS, copyPerson, morePagesLine, type PersonCopy } from "@/lib/person-copy";
import { storeForEmail } from "@/lib/store";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// The store's Stripe account answers that the person paid nothing there.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const realNow = Date.now;
const realPipeline = redis.pipeline.bind(redis);
let commands = 0;
const counting = () => {
  commands = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return realPipeline(batch);
  }) as typeof redis.pipeline;
};
const stopCounting = () => (redis.pipeline = realPipeline as typeof redis.pipeline);

type Wrote = { posts: { post: string }[]; comments: { comment: string }[] };
const community = (copy: PersonCopy): Wrote[] => copy.sections.filter((s) => s.module === "lib/community-erasure.ts").flatMap((s) => s.records as Wrote[]);

async function main(): Promise<void> {
  part("Sealed to the store and the address");
  const whose = { sid: "sid_one", email: "ada@example.com" };
  const sealed = sealCursor(whose, { module: "lib/community-erasure.ts#c1", page: 2, resume: "s:123", complete: true })!;
  is("opens for them", openCursor(whose, sealed), { module: "lib/community-erasure.ts#c1", page: 2, resume: "s:123", complete: true });
  is("not for another address", openCursor({ ...whose, email: "bob@example.com" }, sealed), null);
  is("not for another store", openCursor({ ...whose, sid: "sid_two" }, sealed), null);
  const [body, seal] = sealed.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, m: "lib/community-erasure.ts#c1", p: 2, r: "s:999", c: true })).toString("base64url");
  is("not with its position changed", openCursor(whose, `${forged}.${seal}`), null);
  is("not with its seal changed", openCursor(whose, `${body}.${Buffer.alloc(32).toString("base64url")}`), null);
  is("not anything else", [openCursor(whose, ""), openCursor(whose, 42), openCursor(whose, `${body}.${seal}.x`)], [null, null, null]);
  is("page 1 is never a cursor", sealCursor(whose, { module: "m", page: 1, resume: "s:1", complete: true }), null);
  const key = process.env.NIMBUS_DATA_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  const stripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  is("with no deployment key, no cursor is sealed", sealCursor(whose, { module: "m", page: 2, resume: "s:1", complete: true }), null);
  is("and none opens", openCursor(whose, sealed), null);
  process.env.NIMBUS_DATA_KEY = key;
  if (stripe !== undefined) process.env.STRIPE_SECRET_KEY = stripe;

  redis.clear();
  const w = await makeWorld();
  const person = normaliseEmail("pages-member@example.com");
  await seedPerson(w, person, null);
  const store = (await storeForEmail(OWNER))!;
  const who = emailKey(person);
  // A community from before the trace began, with more of theirs than one request reads.
  Date.now = () => (TRACED_SINCE - 30 * 86_400) * 1000;
  for (let n = 0; n < Math.ceil(COPY_PAGE_MAX_COMMANDS / 5) + 7; n++) {
    const made = await createPost(w.communityId, { space: "", author: n % 3 === 0 ? who : `other${String(n).padStart(27, "0")}`, title: `Post ${n}`, text: `Text ${n}`, img: null, kind: "post", poll: null }, store);
    if (!made.ok) throw new Error(`post ${n} not made`);
    await addComment(w.communityId, made.post.id, { parent: "", author: n % 2 === 0 ? who : `other${String(n + 1).padStart(27, "0")}`, text: `Comment ${n}` }, store);
  }
  Date.now = realNow;
  const whole = await memberTraces(w.communityId, who);
  const scope = (await erasureScope(store, person))!;

  part("The first page says there is more, with the cursor to ask for it");
  const first = await copyPerson(scope);
  is("page 1", first.page, 1);
  is("not complete", first.complete, false);
  is("it says the copy continues on page 2", first.notComplete.includes(morePagesLine(2)), true);
  is("with a cursor", typeof first.next, "string");
  is("the rest of the copy is on it, as before", first.sections.some((s) => s.module !== "lib/community-erasure.ts"), true);

  part("Each next page, asked for with the cursor, reads under the bound, until the last");
  const pages = [first];
  let largest = 0;
  while (pages.at(-1)!.next && pages.length < 100) {
    counting();
    try {
      pages.push(await copyPerson(scope, Date.now(), { cursor: pages.at(-1)!.next }));
    } finally {
      stopCounting();
    }
    largest = Math.max(largest, commands);
  }
  const last = pages.at(-1)!;
  is(`more than one page (${pages.length})`, pages.length > 1, true);
  is("numbered in turn", pages.map((p) => p.page), pages.map((_, i) => i + 1));
  is(`no later page sent more than ${COPY_PAGE_MAX_COMMANDS} commands (largest ${largest})`, largest <= COPY_PAGE_MAX_COMMANDS, true);
  is("the last has no cursor", last.next, undefined);
  is("and says the copy is complete, as the first page read everything else", [last.complete, last.notComplete], [first.notComplete.length === 1, []]);
  const posts = pages.flatMap(community).flatMap((r) => r.posts.map((p) => p.post)).sort();
  const comments = pages.flatMap(community).flatMap((r) => r.comments.map((c) => c.comment)).sort();
  is("their posts, every one once, across the pages", posts, whole.posts.map((p) => p.post).sort());
  is("their comments, every one once, across the pages", comments, whole.comments.map((c) => c.comment).sort());

  part("The last page is complete only when every page before it read everything it reached");
  const opened = openCursor({ sid: scope.sid, email: scope.email }, first.next)!;
  is("the first page's cursor says the first page read everything else", opened.complete, true);
  let cursor: string | undefined = sealCursor({ sid: scope.sid, email: scope.email }, { ...opened, complete: false })!;
  let end: PersonCopy | null = null;
  for (let n = 0; cursor && n < 100; n++) {
    end = await copyPerson(scope, Date.now(), { cursor });
    cursor = end.next;
  }
  is("after a first page that left something unread, the last page is not complete", end?.complete, false);
  is("and it is still the last page", end?.next, undefined);

  part("The community's copier read alone, outside copyPerson, refuses more than one page rather than stop short");
  let alone = "";
  try {
    await COPIERS["lib/community-erasure.ts"]!(scope);
  } catch (error) {
    alone = error instanceof Error ? error.message : String(error);
  }
  is("it refuses", /more than one page/.test(alone), true);

  part("A cursor that is not theirs reads nothing of theirs: the copy starts again");
  const other = (await erasureScope(store, normaliseEmail("someone-else@example.com")))!;
  const theirs = await copyPerson(other, Date.now(), { cursor: first.next });
  is("another address with their cursor gets its own first page", [theirs.page, theirs.email], [1, other.email]);
  is("and none of their posts", community(theirs).flatMap((r) => r.posts.map((p) => p.post)).some((post) => posts.includes(post)), false);
  const changed = await copyPerson(scope, Date.now(), { cursor: `${first.next!.slice(0, -2)}AA` });
  is("a changed cursor is the first page again", changed.page, 1);

  done();
}

main().catch((error) => {
  Date.now = realNow;
  stopCounting();
  console.error(error);
  process.exit(1);
});
