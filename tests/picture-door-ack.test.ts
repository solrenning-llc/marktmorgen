/**
 * Codex P on #2156 (codex/p-review-2156-picture-door-ack@af0094cb, unchanged but for this note): picture ownership may be authorized only by the
 * exact Redis acknowledgements the door requested.
 */
import { notePictureDoor, takePictureDoor } from "@/lib/picture-door";
import { claimNewPictures } from "@/lib/sales-page-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
const PATH = `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`;
const NOW = 1_800_000_000_000;

async function withReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  return withReplies([reply], run);
}

/** Each pipeline sent is answered with the next of these replies (a take reads, then removes: two pipelines). */
async function withReplies<T>(replies: unknown[], run: () => Promise<T>): Promise<T> {
  let at = 0;
  redis.pipeline = (async () => replies[Math.min(at++, replies.length - 1)]) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function take(replies: unknown[]): Promise<string[] | "unknown"> {
  try {
    return await withReplies(replies, async () => [...(await takePictureDoor([PATH], NOW)).keys()]);
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  part("The upload door needs its whole write acknowledgement");
  is("a short write reply does not open the upload door", await withReply([0], () => notePictureDoor(PATH, NOW)), false);
  // Both adds, the store list's expiry, the taken mark's absence and the store's count (lib/picture-door.ts, since rule 24
  // inventory A1b: the store's list and the list of unclaimed pictures; since Claude 2 on #3347: the expiry and the mark).
  is("the canonical write reply opens it", await withReply([1, 1, 1, 0, 1], () => notePictureDoor(PATH, NOW)), true);
  is("a numeric-looking mark answer does not open it", await withReply([1, 1, 1, "0", 1], () => notePictureDoor(PATH, NOW)), false);
  is("an expiry not set does not open it", await withReply([1, 1, 0, 0, 1], () => notePictureDoor(PATH, NOW)), false);
  is("a name already taken does not open it", await withReplies([[1, 1, 1, 1, 1], [1, 1]], () => notePictureDoor(PATH, NOW)), false);

  part("Taking a picture needs an exact removal acknowledgement");
  // The score read, then the taken mark and the removals from the list of unclaimed pictures (which decides) and from the store's list.
  is("a numeric-looking removal string is unknown", await take([[String(NOW)], ["OK", "1", 1]]), "unknown");
  is("a mark not acknowledged is unknown", await take([[String(NOW)], [null, 1, 1]]), "unknown");
  is("the canonical score, mark and numeric removal acknowledge the picture", await take([[String(NOW)], ["OK", 1, 1]]), [PATH]);
  part("A page's pictures not read exactly are ours to say, never \"add it again\" (Claude 4 on #2156)");
  let claimed: boolean | "unknown";
  try {
    claimed = await withReply([["only one"]], () => claimNewPictures("a".repeat(24), "page1", [PATH, `${PATH}x`]));
  } catch {
    claimed = "unknown";
  }
  is("an HMGET answer of the wrong length throws, so the route answers server_error", claimed, "unknown");
  done();
}

main().catch((error) => {
  redis.pipeline = real;
  console.error(error);
  process.exit(1);
});
