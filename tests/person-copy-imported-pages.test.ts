/**
 * Issue #5125, row (1) imported-purchases (Claude 1 coord a6e9): a person's imported purchases
 * (nl:imp:buy:<statsId>:<address hash>) are bounded only by the store's data room, so the copy reads them HSCAN by
 * HSCAN inside each request's budget (lib/imported-purchases.ts importedPage), as a paged part of the copy
 * (lib/person-copy.ts PAGED_MODULES). The union of the pages is the whole hash; what was kept from the first page to
 * the last is on the pages exactly once, also with rows given and taken back between pages; each page says which part
 * goes on and how many are left; a cursor that is not theirs reads nothing of theirs. When the community runs out
 * first, their imported purchases wait whole for the pages after it.
 */
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_imported_pages_only";
import { normaliseEmail } from "@/lib/auth";
import { createPost, addComment } from "@/lib/community";
import { COPY_PAGE_MAX_COMMANDS } from "@/lib/copy-pages";
import { TRACED_SINCE } from "@/lib/community-trace";
import { IMPORTED_SCAN_MOST, importedKey } from "@/lib/imported-purchases";
import { emailKey } from "@/lib/learn";
import { erasureScope } from "@/lib/person-erasure";
import { copyPerson, morePagesLine, type PersonCopy } from "@/lib/person-copy";
import { storeForEmail } from "@/lib/store";
import type { ErasureScope } from "@/lib/erasure-rules";
import { OWNER, makeWorld, seedPerson } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// The store's Stripe account answers that the person paid nothing there.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const realNow = Date.now;
const realPipeline = redis.pipeline.bind(redis);
const JOB = "0123456789abcdef01234567";
const row = (n: number) => JSON.stringify({ at: 1_790_000_000 + n, job: JOB, items: null });
const productId = (n: number) => `prod_${String(n).padStart(8, "0")}`;

/**
 * Redis's HSCAN for one hash, COUNT at a time, as a cursor over the order each field was first written: a field kept
 * the whole time is returned once, one written later comes after, one taken back is simply not there. The stand-in
 * (lib/redis-memory.ts) answers a whole hash at once, as Redis does for a small one.
 */
function scanner(key: string, count: number) {
  const order = new Map<string, number>();
  let last = 0;
  return {
    put(fields: string[], value: (field: string) => string) {
      for (const field of fields) {
        if (!order.has(field)) order.set(field, ++last);
        redis.run(["HSET", key, field, value(field)]);
      }
    },
    scan(cmd: (string | number)[]): unknown {
      const from = Number(cmd[2]);
      const kept = new Set(redis.run(["HKEYS", key]) as string[]);
      const ahead = [...order].filter(([field, at]) => at >= from && kept.has(field)).sort((a, b) => a[1] - b[1]);
      const page = ahead.slice(0, count);
      const next = ahead.length > count ? String(ahead[count]![1]) : "0";
      return [next, page.flatMap(([field]) => [field, redis.run(["HGET", key, field]) as string])];
    },
  };
}

let units = 0;
/** Every command, and every row an HSCAN answered: what a page's budget pays for. */
function through(key: string, scan: (cmd: (string | number)[]) => unknown) {
  units = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    units += batch.length;
    if (!batch.some((c) => c[0] === "HSCAN" && c[1] === key)) return realPipeline(batch);
    return batch.map((c) => {
      if (!(c[0] === "HSCAN" && c[1] === key)) return redis.run(c as string[]);
      const reply = scan(c) as [string, string[]];
      units += reply[1].length / 2;
      return reply;
    });
  }) as typeof redis.pipeline;
}
const plain = () => (redis.pipeline = realPipeline as typeof redis.pipeline);

const imported = (copy: PersonCopy) => copy.sections.filter((s) => s.module === "lib/imported-purchases.ts").flatMap((s) => (s.records as { productId: string }[]).map((r) => r.productId));

/** Every page of the copy in turn; `between` runs after each page but the last. */
async function allPages(scope: ErasureScope, key: string, scan: (cmd: (string | number)[]) => unknown, between?: (page: number) => void) {
  const pages: PersonCopy[] = [];
  let largest = 0;
  do {
    if (pages.length && between) between(pages.length);
    through(key, scan);
    try {
      pages.push(await copyPerson(scope, Date.now(), pages.length ? { cursor: pages.at(-1)!.next } : {}));
    } finally {
      plain();
    }
    if (pages.length > 1) largest = Math.max(largest, units);
  } while (pages.at(-1)!.next && pages.length < 200);
  return { pages, largest };
}

async function main(): Promise<void> {
  redis.clear();
  const w = await makeWorld();
  const person = normaliseEmail("pages-imports@example.com");
  await seedPerson(w, person, null);
  const store = (await storeForEmail(OWNER))!;
  const scope = (await erasureScope(store, person))!;
  const key = importedKey(scope.statsId, person);
  const at = `lib/imported-purchases.ts#${scope.statsId}`;
  const hash = scanner(key, 100);
  // More of theirs than one request reads: each HSCAN keeps room for 1 + 2 x IMPORTED_SCAN_MOST until its reply is in.
  const ROWS = 12_000;
  hash.put(Array.from({ length: ROWS }, (_, n) => productId(n)), (field) => row(Number(field.slice(5))));
  const whole = Array.from({ length: ROWS }, (_, n) => productId(n)).sort();

  part("The first page has part of them, says their imported purchases go on, and carries a cursor");
  const read = await allPages(scope, key, (cmd) => hash.scan(cmd));
  const first = read.pages[0]!;
  is("page 1 is not complete", first.complete, false);
  is("it says which part goes on and how many are left", first.notComplete.includes(morePagesLine(2, [at])), true);
  is("it holds some of them already", imported(first).length > 0 && imported(first).length < ROWS, true);
  is("and the rest of the copy, as before", first.sections.some((s) => s.module !== "lib/imported-purchases.ts"), true);

  part("Each later page stays under the bound, and the pages together are the whole hash, each purchase once");
  const pages = read.pages;
  is(`more than one page (${pages.length})`, pages.length > 1, true);
  is("numbered in turn", pages.map((p) => p.page), pages.map((_, i) => i + 1));
  is(`no later page paid for more than ${COPY_PAGE_MAX_COMMANDS} (largest ${read.largest})`, read.largest <= COPY_PAGE_MAX_COMMANDS, true);
  is("the last has no cursor and says the copy is complete", [pages.at(-1)!.next, pages.at(-1)!.complete, pages.at(-1)!.notComplete], [undefined, true, []]);
  const got = pages.flatMap(imported);
  is("every purchase, once", got.sort(), whole);
  is("every page but the last says the same part goes on", pages.slice(1, -1).every((p, i) => p.notComplete.includes(morePagesLine(i + 3, [at]))), true);

  part("Given and taken back between pages: what was kept the whole time is on the pages exactly once");
  const late = productId(ROWS + 1);
  const gone = productId(ROWS - 1);
  const early = productId(0);
  const changed = await allPages(scope, key, (cmd) => hash.scan(cmd), (page) => {
    if (page !== 1) return;
    // One taken back that the first page did not reach (written last), one it did (written first), one given late.
    redis.run(["HDEL", key, gone]);
    redis.run(["HDEL", key, early]);
    hash.put([late], () => row(ROWS + 1));
  });
  const seen = changed.pages.flatMap(imported);
  const kept = whole.filter((id) => id !== gone && id !== early);
  is("each one kept the whole time is there once", kept.every((id) => seen.filter((x) => x === id).length === 1), true);
  is("one taken back before its page was reached is not", seen.includes(gone), false);
  is("nothing is there twice", seen.length, new Set(seen).size);
  is("and nothing that was never theirs", seen.every((id) => whole.includes(id) || id === late), true);
  redis.run(["HDEL", key, late]);
  hash.put([gone, early], (field) => row(Number(field.slice(5))));

  part("A cursor that is not theirs reads nothing of theirs: the copy starts again");
  const other = (await erasureScope(store, normaliseEmail("someone-else@example.com")))!;
  const theirs = await copyPerson(other, Date.now(), { cursor: first.next });
  is("another address with their cursor gets its own first page", [theirs.page, theirs.email], [1, other.email]);
  is("and none of their purchases", imported(theirs).length, 0);
  through(key, (cmd) => hash.scan(cmd));
  let forged: PersonCopy;
  try {
    forged = await copyPerson(scope, Date.now(), { cursor: `${first.next!.slice(0, -2)}AA` });
  } finally {
    plain();
  }
  is("a changed cursor is the first page again", forged.page, 1);

  part("An HSCAN reply larger than a page keeps room for is unknown: the copy fails, never reads past its bound");
  let refused = "";
  const big = scanner(key, IMPORTED_SCAN_MOST + 1);
  big.put(whole.slice(0, IMPORTED_SCAN_MOST + 1), (field) => row(Number(field.slice(5))));
  through(key, (cmd) => big.scan(cmd));
  try {
    await copyPerson(scope);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  } finally {
    plain();
  }
  is("refused", /HSCAN of an address's imported purchases/.test(refused), true);

  part("When the community runs out first, their imported purchases wait whole for the pages after it");
  const who = emailKey(person);
  Date.now = () => (TRACED_SINCE - 30 * 86_400) * 1000;
  for (let n = 0; n < Math.ceil(COPY_PAGE_MAX_COMMANDS / 5) + 7; n++) {
    const made = await createPost(w.communityId, { space: "", author: n % 3 === 0 ? who : `other${String(n).padStart(27, "0")}`, title: `Post ${n}`, text: `Text ${n}`, img: null, kind: "post", poll: null }, store);
    if (!made.ok) throw new Error(`post ${n} not made`);
    await addComment(w.communityId, made.post.id, { parent: "", author: who, text: `Comment ${n}` }, store);
  }
  Date.now = realNow;
  const both = await allPages(scope, key, (cmd) => hash.scan(cmd));
  const opening = both.pages[0]!;
  is("page 1 has none of their imported purchases", imported(opening), []);
  is("it says both parts are still to read", opening.notComplete.includes(morePagesLine(2, [`lib/community-erasure.ts#${w.communityId}`, at])), true);
  is(`no later page paid for more than ${COPY_PAGE_MAX_COMMANDS} (largest ${both.largest})`, both.largest <= COPY_PAGE_MAX_COMMANDS, true);
  is("the pages after hold every purchase, once", both.pages.flatMap(imported).sort(), whole);
  is("the last says the copy is complete", [both.pages.at(-1)!.next, both.pages.at(-1)!.complete], [undefined, true]);

  done();
}

main().catch((error) => {
  Date.now = realNow;
  plain();
  console.error(error);
  process.exit(1);
});
