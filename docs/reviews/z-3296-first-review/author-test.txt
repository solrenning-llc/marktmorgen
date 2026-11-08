/**
 * A review request's link, written and noted for erasure only when both replies read exactly (CX-123 rule 24, audit
 * round 7, candidate C1). mintReviewLink sends the link's SET (the order and the buyer's address in it, kept 60 days)
 * and the erasure index's note in one pipeline whose replies were never read: a note that did not land left a link
 * with the address that an erasure could not find, and a SET that did not land sent an email with a dead link. Now
 * the SET must answer "OK" and every note a count; anything else takes the link back (best effort) and throws
 * UnknownReplyError, so no email is sent on it. Synthetic only: the in-memory Redis double and the real
 * lib/review-proof.ts and lib/erasure-index.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "@/lib/store";
import { REVIEW_LINK_PATTERN, mintReviewLink } from "@/lib/review-proof";
import { forgetNoted } from "@/lib/erasure-index";
import { store as redis } from "./redis-stub";

const STATS = "0123456789abcdef0123456789abcdef";
const EMAIL = "reviewer@buyer.example";
const REFERENCE = "pi_reviewproof0001";
const store = { statsId: STATS, handle: "reviewroom" } as unknown as Store;

const real = redis.pipeline.bind(redis);
let rewrite: ((replies: unknown[]) => unknown) | null = null;
let linkKey = "";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const first = commands[0];
  if (first?.[0] === "SET" && /^nl:rev:link:/.test(String(first[1]))) {
    linkKey = String(first[1]);
    const replies = (await real(commands)) as unknown[];
    return (rewrite ? rewrite(replies) : replies) as unknown[];
  }
  return real(commands);
}) as typeof redis.pipeline;

const at = (i: number, value: unknown) => (replies: unknown[]) => replies.map((reply, j) => (j === i ? value : reply));

const UNKNOWN: [string, (replies: unknown[]) => unknown][] = [
  ["the link's SET answers nil", at(0, null)],
  ["the link's SET answers a number", at(0, 1)],
  ["the link's SET answers an undefined slot", at(0, undefined)],
  ["the index's ZADD answers text", at(1, "x")],
  ["the index's trim answers nil", at(2, null)],
  ["the index's EXPIRE answers a negative number", at(3, -1)],
  ["a reply is missing", (replies) => replies.slice(0, -1)],
  ["a reply too many", (replies) => [...replies, 1]],
  ["the pipeline answers something that is not a list", () => "OK"],
];

for (const [label, change] of UNKNOWN) {
  test(`mintReviewLink throws, and takes the link back, when ${label}`, async () => {
    redis.clear();
    linkKey = "";
    rewrite = change;
    try {
      await assert.rejects(mintReviewLink(store, REFERENCE, EMAIL), { name: "UnknownReplyError" });
    } finally {
      rewrite = null;
    }
    assert.ok(linkKey, "the link's write is exercised");
    const [left] = await redis.pipeline([["GET", linkKey]]);
    assert.equal(left, null, "no link with the buyer's address is left behind that was never sent");
  });
}

test("a healthy link is written, noted for erasure, opened by its key and deleted with the address (control)", async () => {
  redis.clear();
  linkKey = "";
  const token = await mintReviewLink(store, REFERENCE, EMAIL);
  assert.match(token, REVIEW_LINK_PATTERN);
  const [raw] = await redis.pipeline([["GET", linkKey]]);
  assert.deepEqual(JSON.parse(String(raw)), { s: STATS, r: REFERENCE, e: EMAIL });
  assert.ok((await forgetNoted(STATS, EMAIL)) >= 1, "the erasure finds the link through its note");
  const [gone] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(gone, null);
});

test("a store with no stats id writes the link alone and reads its one reply (control)", async () => {
  redis.clear();
  linkKey = "";
  const token = await mintReviewLink({ ...store, statsId: null } as unknown as Store, REFERENCE, EMAIL);
  assert.match(token, REVIEW_LINK_PATTERN);
  const [raw] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(typeof raw, "string");
});
