/**
 * A review request's link, written and noted for erasure only when both replies read exactly (CX-123 rule 24, audit
 * round 7, candidate C1). mintReviewLink sends the link's SET (the order and the buyer's address in it, kept 60 days)
 * and the erasure index's note in one pipeline whose replies were never read: a note that did not land left a link
 * with the address that an erasure could not find, and a SET that did not land sent an email with a dead link. Now
 * the SET must answer "OK" and every note a count; anything else takes the link back (best effort) and throws
 * UnknownReplyError, so no email is sent on it. Since Codex Z's review of #3296 the note is written and read first, so a
 * link that may have landed is always one an erasure finds, also when its pipeline threw or its take-back failed.
 * Synthetic only: the in-memory Redis double and the real
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

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let rewrite: ((commands: Command[], replies: unknown[]) => unknown) | null = null;
// Runs only the link's SET of its pipeline, for real, and then throws: a write that landed while its pipeline's
// outcome is not known (Codex Z on #3296).
let commitSetThenThrow = false;
let failTakeBack = false;
// Runs a real erasure of the address right after the pipeline carrying the erasure note answered, before the link is
// written (Codex Z on #3296, review 5819974680).
let eraseAfterNote = false;
let linkKey = "";
// The link's write: one step that writes it only while its erasure note is there, or a plain SET without a note.
const isLinkSet = (c: Command) =>
  (c[0] === "SET" && /^nl:rev:link:/.test(String(c[1]))) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:review-link-if-noted:v1\n"));
const linkOf = (c: Command) => String(c[0] === "EVAL" ? c[4] : c[1]);
const isNote = (c: Command) => c[0] === "ZADD" && /^nl:erase:ix:/.test(String(c[1])) && /^nl:rev:link:/.test(String(c[3]));
redis.pipeline = (async (commands: Command[]) => {
  const set = commands.find(isLinkSet);
  const note = commands.find(isNote);
  if (set) linkKey = linkOf(set);
  else if (note) linkKey = String(note[3]);
  if (commands.length === 1 && commands[0][0] === "DEL" && /^nl:rev:link:/.test(String(commands[0][1])) && failTakeBack) {
    throw new Error("synthetic: the take-back's outcome is unknown");
  }
  if (set && commitSetThenThrow) {
    await real([set]);
    throw new Error("synthetic: the pipeline's outcome is unknown after its SET landed");
  }
  if (set || note) {
    const replies = (await real(commands)) as unknown[];
    if (note && !set && eraseAfterNote) {
      eraseAfterNote = false;
      await forgetNoted(STATS, EMAIL);
    }
    return (rewrite ? rewrite(commands, replies) : replies) as unknown[];
  }
  return real(commands);
}) as typeof redis.pipeline;

/** Replaces the reply of the named command, in whichever pipeline carries it. */
const reply = (name: string, value: unknown) => (commands: Command[], replies: unknown[]) =>
  replies.map((r, j) => (commands[j]?.[0] === name ? value : r));
/** Changes the whole reply list of the pipeline that carries the named command. */
const pipe = (name: string, change: (replies: unknown[]) => unknown) => (commands: Command[], replies: unknown[]) =>
  commands.some((c) => c[0] === name) ? change(replies) : replies;

const UNKNOWN: [string, (commands: Command[], replies: unknown[]) => unknown][] = [
  ["the link's write answers nil", reply("EVAL", null)],
  ["the link's write answers a number that is neither 1 nor 0", reply("EVAL", 2)],
  ["the link's write answers text", reply("EVAL", "OK")],
  ["the link's write answers an undefined slot", reply("EVAL", undefined)],
  ["the index's ZADD answers text", reply("ZADD", "x")],
  ["the index's trim answers nil", reply("ZREMRANGEBYSCORE", null)],
  ["the index's EXPIRE answers a negative number", reply("EXPIRE", -1)],
  ["a reply is missing from the link's write", pipe("EVAL", (replies) => replies.slice(0, -1))],
  ["a reply is missing from the erasure note", pipe("ZADD", (replies) => replies.slice(0, -1))],
  ["a reply too many on the link's write", pipe("EVAL", (replies) => [...replies, 1])],
  ["a reply too many on the erasure note", pipe("ZADD", (replies) => [...replies, 1])],
  ["the link's write answers something that is not a list", pipe("EVAL", () => "OK")],
  ["the erasure note answers something that is not a list", pipe("ZADD", () => "OK")],
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

/** Runs mintReviewLink with console.error captured; returns the error it threw and what it logged. */
async function mintCapturing(): Promise<{ error: unknown; logged: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await mintReviewLink(store, REFERENCE, EMAIL);
    return { error: null, logged: lines.join("\n") };
  } catch (error) {
    return { error, logged: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

// Codex Z's regression on #3296 (review 5819908433): the pipeline throws after only the grant's SET landed. No
// token may come back, and the grant, with the buyer's address in it, must not outlive an erasure of that address.
test("a pipeline that throws after the link's SET landed returns no token, and an erasure still finds no link (Codex Z)", async () => {
  redis.clear();
  linkKey = "";
  commitSetThenThrow = true;
  const { error } = await mintCapturing().finally(() => (commitSetThenThrow = false));
  assert.ok(error instanceof Error, "it throws: no token, so no email");
  assert.ok(linkKey, "the link's write is exercised");
  await forgetNoted(STATS, EMAIL);
  const [left] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(left, null, "the grant is gone after the address's erasure");
});

test("when the take-back itself fails too, the link is still noted for erasure, and the log says what is left", async () => {
  redis.clear();
  linkKey = "";
  commitSetThenThrow = true;
  failTakeBack = true;
  const { error, logged } = await mintCapturing().finally(() => {
    commitSetThenThrow = false;
    failTakeBack = false;
  });
  assert.ok(error instanceof Error, "it throws: no token, so no email");
  const [kept] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(typeof kept, "string", "the unsent link may be left (the take-back's outcome is unknown)");
  assert.match(logged, /review request's link/, "the log names what may be left");
  await forgetNoted(STATS, EMAIL);
  const [left] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(left, null, "but an erasure of the address finds it and deletes it");
});

test("an unknown write whose take-back fails is still erased with the address", async () => {
  redis.clear();
  linkKey = "";
  rewrite = reply("EVAL", null);
  failTakeBack = true;
  const { error } = await mintCapturing().finally(() => {
    rewrite = null;
    failTakeBack = false;
  });
  assert.equal((error as Error | null)?.name, "UnknownReplyError");
  await forgetNoted(STATS, EMAIL);
  const [left] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(left, null, "the erasure finds the link it may have left");
});

// Codex Z's race on #3296 (review 5819974680): the erasure note is confirmed, then the address is erased in full
// (index and every noted record), then the link would be written. The erased address must not come back in an
// unindexed grant that no later erasure can find, and no token may come back for an email.
test("an erasure that runs between the note and the link's write is never undone: no token, no grant (Codex Z)", async () => {
  redis.clear();
  linkKey = "";
  eraseAfterNote = true;
  const { error } = await mintCapturing().finally(() => (eraseAfterNote = false));
  assert.ok(error instanceof Error, "it throws: no token, so no email");
  assert.ok(linkKey, "the link's key is known");
  const [left] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(left, null, "no grant with the erased address is written after the erasure");
  await forgetNoted(STATS, EMAIL);
  const [still] = await redis.pipeline([["GET", linkKey]]);
  assert.equal(still, null, "nor is one left that a second erasure cannot find");
});

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
