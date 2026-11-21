/**
 * A picture put back on its door (lib/picture-door.ts returnToDoor; Claude 5, #2843) against this branch's sweep of
 * pictures never put on anything (#3347):
 *   (1) putting one picture back never puts an expiry on its store's whole list of notes: that list has none (the
 *       E family of lib/data-families.ts, nl:pictures:doors:) and the sweep reads every other picture's note on it;
 *   (2) a picture put back is again one the sweep can find: on nl:pictures:unclaimed at the same time, its taken mark
 *       gone, so a picture put back and never used is swept like any other, never kept for good.
 * Synthetic data only; the Redis double, no file store.
 */
import { PICTURE_SWEEP_AFTER_SECONDS, notePictureDoor, returnToDoor, sweepPictureDoors, takePictureDoor } from "@/lib/picture-door";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const FOLDER = "a1b2c3d4e5f6a7b8c9d0e1f2";
const DOORS = `nl:pictures:doors:${FOLDER}`;
const UNCLAIMED = "nl:pictures:unclaimed";
const RETURNED = `images/${FOLDER}/returned.jpg`;
const OTHER = `images/${FOLDER}/other.jpg`;
const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  redis.clear();
  const t0 = Date.now();
  is("control: two pictures let in through the door", [await notePictureDoor(RETURNED, t0), await notePictureDoor(OTHER, t0)], [true, true]);
  const taken = await takePictureDoor([RETURNED], t0 + 1_000);
  const at = taken.get(RETURNED);
  is("control: one of them taken from the door", typeof at, "number");
  is("control: off both lists, marked taken", [redis.run(["ZSCORE", DOORS, RETURNED]), redis.run(["ZSCORE", UNCLAIMED, RETURNED]), Number(redis.run(["EXISTS", `nl:pictures:taken:${RETURNED}`]))], [null, null, 1]);

  // A check that did not finish puts it back once, at its time plus half a millisecond (lib/picture-check.ts).
  const back = Math.floor(at as number) + 0.5;
  await returnToDoor([[RETURNED, back]]);

  part("(1) Putting one picture back puts no expiry on its store's list");
  is("the store's list of notes still has no expiry", redis.run(["TTL", DOORS]), -1);
  advance(DAY + 60_000);
  is("a day on, the other picture's note is still there for the sweep", redis.run(["ZSCORE", DOORS, OTHER]) !== null, true);

  part("(2) A picture put back is one the sweep can find again");
  is("back on the list of unclaimed pictures, at the same time as its store note", [Number(redis.run(["ZSCORE", UNCLAIMED, RETURNED])), Number(redis.run(["ZSCORE", DOORS, RETURNED]))], [back, back]);
  is("its taken mark is gone", Number(redis.run(["EXISTS", `nl:pictures:taken:${RETURNED}`])), 0);
  const removed: string[] = [];
  const later = t0 + PICTURE_SWEEP_AFTER_SECONDS * 1000 + DAY;
  const swept = await sweepPictureDoors(async (paths) => { removed.push(...paths); }, later, 50, async () => ({ uploadedAt: new Date(t0 + 2_000) }));
  is("never used, it is swept past its 30 days like any other", [swept.includes(RETURNED), removed.includes(RETURNED)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
