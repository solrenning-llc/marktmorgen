/**
 * A like and the author's point change together, or not at all, whatever happens between them (#3819: Codex V, G
 * and U, MEDIUM; Codex P, HIGH; transcribed 15/11/2026).
 *
 * pressLike took a 20-second lock and then changed the like (with its trace and its room) and the author's point in
 * separate Redis steps, without checking that the lock was still its own. So:
 *   - a press paused past the lock's term, between the like and the point, let a second press take the lock and
 *     change the like back; the first then gave its point for a like that was gone (Codex V, Codex P 17:46);
 *   - a point write that failed after the like changed left the like and the point apart, and an error answered
 *     (Codex G, Codex P 12:40);
 *   - a press paused past the term before it wrote a like it found there wrote it again without taking its room
 *     (Codex U).
 * Each case here ends with the like and the author's point agreeing, and the room counted for what is kept.
 * Synthetic data only: the memory Redis, its clock moved by the test.
 */
import * as community from "@/lib/community";
import { pointsOf } from "@/lib/community-points";
import { dataUsed } from "@/lib/store-data";
import { ROOM } from "./data-room";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Press = (id: string, post: string, comment: string | null, who: string, author: string, room: typeof ROOM, owner: typeof ROOM) => Promise<boolean | null>;
const pressLike = (community as Record<string, unknown>).pressLike as Press;

const ID = "c".repeat(32);
const POST = "p1";
const WHO = "m".repeat(32);
const AUTHOR = "a".repeat(32);
const likes = `nl:cm:${ID}:l:${POST}`;

const real = redis.pipeline.bind(redis);
/** Whether a batch is the step that writes the author's point (whatever script carries it). */
const pointStep = (batch: Command[]) =>
  batch.some((c) => c[0] === "EVAL" && /-- marktmorgen:(order-write|community-point-remove|community-like-press):/.test(String(c[1])));
/** Whether a batch is the step that writes the like itself. */
const likeStep = (batch: Command[]) =>
  batch.some((c) => (c[0] === "SADD" && c[1] === likes) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:community-like-press:")));

/** A press held at the first batch `at` picks, until `release` is called. */
let hold: { at: (batch: Command[]) => boolean; reached: () => void; until: Promise<void> } | null = null;
/** A batch `at` picks fails before Redis runs it, once. */
let fail: ((batch: Command[]) => boolean) | null = null;

redis.pipeline = (async (batch: Command[]) => {
  if (hold && hold.at(batch)) {
    const h = hold;
    hold = null;
    h.reached();
    await h.until;
  }
  if (fail && fail(batch)) {
    fail = null;
    throw new Error("Synthetic Redis failure before the command ran");
  }
  // The memory Redis plays named scripts; REMOVE_POINT is played here as tests/community-like-exact.test.ts does.
  const one = batch[0];
  if (batch.length === 1 && one?.[0] === "EVAL" && String(one[1]).startsWith("-- marktmorgen:community-point-remove:")) {
    const [total, today] = await real([["ZSCORE", String(one[3]), String(one[5])], ["ZSCORE", String(one[4]), String(one[5])]]);
    const n = (raw: unknown) => (raw === null ? 0 : Number(raw));
    const writes: Command[] = [];
    if (n(total) > 0) writes.push(["ZINCRBY", String(one[3]), -1, String(one[5])]);
    if (n(today) > 0) writes.push(["ZINCRBY", String(one[4]), -1, String(one[5])]);
    if (writes.length) await real(writes);
    return [[n(total) > 0 ? 1 : 0, n(today) > 0 ? 1 : 0]];
  }
  return real(batch);
}) as typeof redis.pipeline;

function holdAt(at: (batch: Command[]) => boolean): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const was = new Promise<void>((resolve) => (reached = resolve));
  const until = new Promise<void>((resolve) => (release = resolve));
  hold = { at, reached, until };
  return { reached: was, release };
}

/** The author is a member still in the community (lib/community-push.ts STILL_IN reads this record): only then is a point given. */
async function seedAuthor(): Promise<void> {
  await real([["HSET", `nl:cm:${ID}:m`, AUTHOR, JSON.stringify({ k: AUTHOR, e: "author@example.test", removed: false, muted: false })]]);
}

const liked = async () => (await real([["SISMEMBER", likes, WHO]]))[0] === 1;
const points = async () => (await pointsOf(ID, [AUTHOR])).get(AUTHOR) ?? 0;
const settle = (run: Promise<unknown>) => run.then(() => "done", () => "refused");
/** The like and the author's point agree: one point while the like is there, none once it is gone. */
async function agree(): Promise<boolean> {
  return (await liked()) === ((await points()) > 0);
}

async function main(): Promise<void> {
  part("Codex V, Codex P (17:46): a press paused past the lock's term never gives a point for a like that is gone");
  {
    redis.clear();
    await seedAuthor();
    const paused = holdAt(pointStep);
    const first = settle(pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM));
    await paused.reached;
    advance(21_000);
    // The second press takes the lock the first one lost, and changes the like back.
    await settle(pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM));
    paused.release();
    await first;
    is("the like and the author's point agree", await agree(), true);
  }

  part("Codex G, Codex P (12:40): a point write that fails never leaves the like and the point apart");
  for (const start of [false, true]) {
    redis.clear();
    await seedAuthor();
    if (start) await pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM);
    fail = pointStep;
    const outcome = await settle(pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM));
    fail = null;
    is(`${start ? "taking a like back" : "a new like"}: the press is refused`, outcome, "refused");
    is(`${start ? "taking a like back" : "a new like"}: the like and the author's point agree`, await agree(), true);
    // Pressed again: one point for one like at the most, never two.
    await pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM);
    is(`${start ? "taking a like back" : "a new like"}, pressed again: they still agree`, await agree(), true);
  }

  part("Codex U: a press paused past the term never writes a like again without its room");
  {
    redis.clear();
    await seedAuthor();
    await pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM);
    const paused = holdAt(likeStep);
    const first = settle(pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM));
    await paused.reached;
    advance(21_000);
    await settle(pressLike(ID, POST, null, WHO, AUTHOR, ROOM, ROOM));
    paused.release();
    await first;
    // What the room holds for this post's likes and the member's trace: the like's entry and its trace entry while
    // the like is kept, nothing once it is gone.
    const used = await dataUsed(ROOM);
    const keptLike = await liked();
    is("the like and the author's point agree", await agree(), true);
    is("a like kept is a like counted in the room", keptLike ? used > 0 : true, true);
  }
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
