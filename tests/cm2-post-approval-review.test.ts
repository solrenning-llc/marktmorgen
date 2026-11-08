/**
 * 543 [CM2] (#3020): what the independent review by Claude 2 found in the
 * approval of posts and comments, kept as permanent checks. The proofs are
 * Claude 2's (tests c2-3020-sweep-batch, c2-3020-approve-twice,
 * c2-3020-picture-left and c2-3020-hold-expired-room in the review), joined
 * here with the same checks on the sibling paths next to each one.
 *
 * 1. An item past HELD_DAYS is refused by itself, and its author already
 *    reads it as "expired": it is never shown to the creator as waiting nor
 *    approved, however many are due (the sweep only takes a batch at a time).
 * 2. A write of the post (or the comment) applied by Redis whose reply was
 *    lost leaves it published once: the item does not wait again, and
 *    approving it again never publishes it twice.
 * 3. The picture of a held post is deleted even when its record ran out
 *    (nobody opened the studio for KEEP_DAYS), and erasing its author
 *    reaches it.
 * 4. Items that already expired do not take the community's room (MAX_HELD).
 * 5. A member's visit to the community, with nothing of theirs waiting,
 *    reads once and writes nothing.
 *
 * Synthetic data only.
 */
import { feed, readComments } from "@/lib/community";
import { HELD_DAYS, KEEP_DAYS, MAX_HELD, approveHeld, forgetHeldPerson, heldOf, heldQueue, holdComment, holdPost, removeHeld } from "@/lib/community-approval";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const SPACE = "aaaaaaaaaaaa";
const DAY = 86_400;
const DUE = 60;
const ada = "a".repeat(31) + "1";
const folder = "f".repeat(24);
const post = (author: string, text: string) => ({ space: SPACE, author, title: "", text, img: null, kind: "post" as const, poll: null });
const who = (i: number) => (i + 1).toString(16).padStart(32, "0");
const picture = (n: number) => ({ path: `community/${folder}/held-${n}.png`, w: 100, h: 100, alt: "A drawing" });
const withPicture = (n: number) => ({ space: SPACE, author: ada, title: "", text: "", img: picture(n), kind: "post" as const, poll: null });

// The test environment has no Blob token: every attempt to delete a picture
// ends in dropCommunityImage's log line, which is what is counted here.
let attempts = 0;
const realError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("could not delete a community picture")) {
    attempts += 1;
    return;
  }
  realError(...args);
};

async function fill(t0: number): Promise<string[]> {
  redis.clear();
  const ids: string[] = [];
  for (let i = 0; i < DUE; i += 1) {
    const one = await holdPost(id, post(who(i), `post ${i}`), ROOM, t0 + i);
    if (!one.ok) throw new Error("not held");
    ids.push(one.held.id);
  }
  return ids;
}

/** Throws once, after Redis applied it, for the pipeline whose first command writes a key starting so. */
function loseReplyOnce(command: string, prefix: string): () => void {
  const real = redis.pipeline.bind(redis);
  let once = true;
  redis.pipeline = async (commands) => {
    const replies = await real(commands);
    if (once && commands[0]?.[0] === command && String(commands[0][1]).startsWith(prefix)) {
      once = false;
      throw new Error("The operation was aborted due to timeout");
    }
    return replies;
  };
  return () => {
    redis.pipeline = real;
  };
}

async function main(): Promise<void> {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const t0 = Math.floor(Date.now() / 1000);
  const late = t0 + HELD_DAYS * DAY + DUE + 10;

  part(`Finding 1 (Claude 2): ${DUE} items past ${HELD_DAYS} days, nobody answered`);
  let ids = await fill(t0);
  const last = ids[DUE - 1];
  is("its author is told it expired and was not published", (await heldOf(id, who(DUE - 1), late)).map((h) => h.state), ["expired"]);
  const approved = await approveHeld(id, last, ROOM, late);
  is("the creator cannot approve it after that", approved.ok, false);
  is("so it is never published", (await feed(id, { withHidden: true })).posts.length, 0);
  is("its author still reads it as expired", (await heldOf(id, who(DUE - 1), late)).map((h) => h.state), ["expired"]);

  ids = await fill(t0);
  is("removing one past the batch is refused too: it already expired", (await removeHeld(id, ids[DUE - 1], "No", late)).ok, false);
  is("and its author reads it as expired, not as removed", (await heldOf(id, who(DUE - 1), late)).map((h) => h.state), ["expired"]);

  part("Finding 1 (Claude 2): the creator's queue after the same wait");
  ids = await fill(t0);
  is("none of them is shown as waiting", (await heldQueue(id, late)).length, 0);
  is("nor on the next look", (await heldQueue(id, late)).length, 0);

  part("Finding 4 (Claude 2): expired items do not take the community's room");
  redis.clear();
  for (let i = 0; i < MAX_HELD; i += 1) {
    const one = await holdPost(id, post(who(i), `post ${i}`), ROOM, t0 + i);
    if (!one.ok) throw new Error("not held");
  }
  const later = t0 + HELD_DAYS * DAY + MAX_HELD + 10;
  const fresh = await holdPost(id, post("e".repeat(31) + "9", "A new member's first post"), ROOM, later);
  is("a new post is held: nothing is waiting any more", fresh.ok, true);
  is("and it is the only one waiting", (await heldQueue(id, later + 1)).length, 1);

  part("Finding 2 (Claude 2): the post is written, then its reply is lost (a timeout)");
  redis.clear();
  const held = await holdPost(id, { ...post(ada, "Hello"), poll: null }, ROOM, t0);
  if (!held.ok) throw new Error("not held");
  let restore = loseReplyOnce("SET", `nl:cm:${id}:p:`);
  const first = await approveHeld(id, held.held.id, ROOM, t0 + 10).catch(() => null);
  restore();
  is("the creator is told it was published (its write was found)", first?.ok, true);
  is("the post is in the feed", (await feed(id, { withHidden: true })).posts.length, 1);
  is("so it is not waiting any more", (await heldQueue(id, t0 + 11)).map((h) => h.id), []);
  is("nor shown to its author as waiting", (await heldOf(id, ada, t0 + 11)).map((h) => h.state), []);
  await approveHeld(id, held.held.id, ROOM, t0 + 12).catch(() => null);
  is("the creator clicks Approve again: still published once", (await feed(id, { withHidden: true })).posts.length, 1);

  part("Finding 2, next door: the same for a comment");
  const above = (await feed(id, { withHidden: true })).posts[0];
  const reply = await holdComment(id, { post: above.id, space: SPACE, parent: "", author: ada, text: "Thanks" }, ROOM, t0 + 20);
  if (!reply.ok) throw new Error("not held");
  restore = loseReplyOnce("HSET", `nl:cm:${id}:c:`);
  const second = await approveHeld(id, reply.held.id, ROOM, t0 + 30).catch(() => null);
  restore();
  is("the comment is published, and said so", second?.ok, true);
  is("it is not waiting any more", (await heldQueue(id, t0 + 31)).map((h) => h.id), []);
  await approveHeld(id, reply.held.id, ROOM, t0 + 32).catch(() => null);
  is("approved again: still one comment", (await readComments(id, above.id)).length, 1);

  part("Finding 2, the other way: nothing was written, so it waits again");
  redis.clear();
  const again = await holdPost(id, post(ada, "Once more"), ROOM, t0);
  if (!again.ok) throw new Error("not held");
  const real = redis.pipeline.bind(redis);
  let failOnce = true;
  redis.pipeline = async (commands) => {
    if (failOnce && commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(`nl:cm:${id}:p:`)) {
      failOnce = false;
      throw new Error("The operation was aborted due to timeout");
    }
    return real(commands);
  };
  let threw = false;
  await approveHeld(id, again.held.id, ROOM, t0 + 10).catch(() => {
    threw = true;
  });
  redis.pipeline = real;
  is("the creator is shown an error", threw, true);
  is("nothing is in the feed", (await feed(id, { withHidden: true })).posts.length, 0);
  is("it waits again", (await heldQueue(id, t0 + 11)).map((h) => h.id), [again.held.id]);
  is("approved again, it is published once", (await approveHeld(id, again.held.id, ROOM, t0 + 12)).ok, true);
  is("once", (await feed(id, { withHidden: true })).posts.length, 1);

  part("Finding 5 (Claude 2): a member's visit with nothing waiting");
  redis.clear();
  const seen: string[] = [];
  redis.pipeline = async (commands) => {
    for (const command of commands) seen.push(String(command[0]));
    return real(commands);
  };
  await heldOf(id, ada, t0);
  redis.pipeline = real;
  is("one command, a read", seen, ["ZREVRANGEBYSCORE"]);

  part("Finding 3 (Claude 2), control: removing a held post deletes its picture");
  redis.clear();
  const control = await holdPost(id, withPicture(1), ROOM, t0);
  if (!control.ok) throw new Error("not held");
  attempts = 0;
  await removeHeld(id, control.held.id, "", t0 + 5);
  is("one deletion attempt", attempts, 1);

  part(`Finding 3, next door: erasing its author after ${KEEP_DAYS + 1} days, the studio never opened`);
  redis.clear();
  const kept = await holdPost(id, withPicture(3), ROOM, t0);
  if (!kept.ok) throw new Error("not held");
  redis.advance((KEEP_DAYS + 1) * DAY * 1000);
  attempts = 0;
  await forgetHeldPerson(id, ada);
  is("the picture is deleted by the erasure", attempts, 1);

  part(`Finding 3 (Claude 2): a held post with a picture, and nobody opens the studio for ${KEEP_DAYS + 1} days`);
  redis.clear();
  const lost = await holdPost(id, withPicture(2), ROOM, t0);
  if (!lost.ok) throw new Error("not held");
  redis.advance((KEEP_DAYS + 1) * DAY * 1000);
  const gone = t0 + (KEEP_DAYS + 1) * DAY;
  attempts = 0;
  await heldQueue(id, gone);
  await forgetHeldPerson(id, ada);
  is("the picture is deleted (its record expired, but the picture must not stay forever)", attempts, 1);

  done();
}

void main();
