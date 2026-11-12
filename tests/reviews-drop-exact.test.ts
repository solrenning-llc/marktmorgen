/**
 * A removed product's reviews read exactly before they are deleted (rule 24; audit F2 of lib/, 12 November 2026).
 *
 * dropReviews (lib/reviews.ts) reads the product's reviews once (HKEYS, HVALS), deletes them and hands back their
 * photos' paths, which the product route deletes from the picture folder. A reply that cannot be read is unknown:
 * never "no reviews", which would delete the records anyway and lose the paths of the photos buyers added, left in
 * the store's folder with nothing pointing at them, and leave the reviews in the store's lists. Checked against the
 * real code with an in-memory Redis:
 *
 *   - a readable product: its reviews go and their photos are handed back;
 *   - HKEYS or HVALS answered in another shape, a value that is not a review, or the two out of step: it throws,
 *     and the reviews, the lists and the photo stay where they were, for a later removal to read again.
 */
import { checkReviewPhoto, reviewPhotoPath } from "@/lib/review-photo";
import { dropReviews, readReview, saveReview, setReviewPhoto } from "@/lib/reviews";
import type { ReviewPhoto } from "@/lib/review-summary";
import { imageFolder } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const STATS = "e".repeat(32);
const PRODUCT = "mugs000002";
const REF = "owner2@example.com";

function jpeg(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
/** Changes the reply to the product's HKEYS/HVALS read. */
function readAnswer(change: ((keys: unknown, vals: unknown) => [unknown, unknown]) | null): void {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const replies = await realPipeline(commands);
    if (change && commands.length === 2 && commands[0][0] === "HKEYS" && commands[1][0] === "HVALS") {
      const [keys, vals] = change(replies[0], replies[1]);
      return [keys, vals];
    }
    return replies;
  };
}

async function oneWithPhoto(): Promise<{ id: string; photo: ReviewPhoto }> {
  const saved = await saveReview(STATS, { productId: PRODUCT, email: "buyer@example.com", reference: "cs_test_2", pi: "pi_2", rating: 5, text: "Lovely mug.", name: "Ana" }, ROOM, 1_700_000_000_000);
  if (saved.state !== "created" && saved.state !== "updated") throw new Error(`review not written: ${saved.state}`);
  const checked = checkReviewPhoto(jpeg(1200, 900));
  if (typeof checked !== "object") throw new Error("no photo");
  const photo: ReviewPhoto = { path: await reviewPhotoPath(REF, "image/jpeg"), width: checked.width, height: checked.height };
  const put = await setReviewPhoto(STATS, PRODUCT, saved.review.id, photo);
  if (typeof put !== "object") throw new Error("photo not put");
  return { id: saved.review.id, photo };
}

async function main(): Promise<void> {
  redis.clear();
  await imageFolder(REF);

  part("A readable product");
  const first = await oneWithPhoto();
  is("its reviews go and their photos are handed back", [await dropReviews(STATS, PRODUCT), await readReview(STATS, PRODUCT, first.id)], [[first.photo.path], null]);

  part("A read that cannot be trusted");
  const cases: [string, (keys: unknown, vals: unknown) => [unknown, unknown]][] = [
    ["HKEYS answered as a string", (_k, v) => ["OK", v]],
    ["HVALS answered as a string", (k) => [k, "OK"]],
    ["both answered as null", () => [null, null]],
    ["a value that is not a review", (k, v) => [k, (v as unknown[]).map(() => "{not json")]],
    ["a key that is not text", (k, v) => [(k as unknown[]).map(() => 7), v]],
    ["the two out of step", (k) => [k, []]],
  ];
  for (const [what, change] of cases) {
    const kept = await oneWithPhoto();
    readAnswer(change);
    let outcome: string;
    try {
      const photos = await dropReviews(STATS, PRODUCT);
      outcome = `returned ${JSON.stringify(photos)}`;
    } catch {
      outcome = "threw";
    }
    readAnswer(null);
    const still = await readReview(STATS, PRODUCT, kept.id);
    const listed = await realPipeline([["ZSCORE", `nl:rev:all:${STATS}`, `${PRODUCT}|${kept.id}`]]);
    is(`${what}: unknown, nothing deleted, the photo still on its review`, [outcome, still?.photo?.path ?? null, listed[0] !== null], ["threw", kept.photo.path, true]);
    await dropReviews(STATS, PRODUCT);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
