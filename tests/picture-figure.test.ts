/**
 * 507 [SG3], unit 2a: the pictures' figure and its counter, off and wired to
 * no picture door yet (lib/picture-figure-rules.ts, lib/picture-figure.ts).
 *
 *   - the figure is what the store's own month of requests could add: each
 *     studio request a picture of at most MAX_IMAGE_BYTES and each buyer
 *     action a review photo of at most MAX_REVIEW_PHOTO_BYTES, paying or not
 *     (allowanceFor), the same as docs/pictures-figure-proposal.md;
 *   - a place is taken, in bytes, before a picture is kept, and given back
 *     when it is deleted; past the figure it is refused and nothing stays
 *     counted; a reply that does not read is refused (rule 24);
 *   - PICTURE_FIGURE_ON is false: nothing calls it yet.
 */
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { MAX_REVIEW_PHOTO_BYTES } from "@/lib/review-summary";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { PICTURE_FIGURE_ON, picturesFigureFor } from "@/lib/picture-figure-rules";
import { PICTURES_BYTES_KEY, givePictureBytes, takePictureBytes } from "@/lib/picture-figure";
import { monthlyMostBytes } from "./pictures-figure-table";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = 1_900_000_000;
const paid = (tier: "creator" | "pro" | "scale") => ({ tier, subscriptionActive: true, trialEnds: 0, planEndedAt: "", periodEnd: NOW + 86_400 } as never);
const unpaid = { subscriptionActive: false, trialEnds: 0, planEndedAt: "" } as never;

(async () => {
  part("Off, until the owner turns it on");
  is("PICTURE_FIGURE_ON is false", PICTURE_FIGURE_ON, false);

  part("The figure: what the store's own month could add");
  for (const tier of ["creator", "pro", "scale"] as const) {
    is(`${tier}: the proposal's figure`, picturesFigureFor(paid(tier), NOW), monthlyMostBytes(tier));
  }
  is("a store with no plan: its own smaller month", picturesFigureFor(unpaid, NOW), allowanceFor(unpaid, "studio", NOW) * MAX_IMAGE_BYTES + allowanceFor(unpaid, "buyer", NOW) * MAX_REVIEW_PHOTO_BYTES);

  part("A place taken before a picture is kept");
  redis.clear();
  const folder = "f0123456789abcdef0123456789abcd";
  is("within the figure: taken", await takePictureBytes(folder, 600, 1_000), true);
  is("and counted", Number(redis.run(["GET", PICTURES_BYTES_KEY(folder)])), 600);
  is("past the figure: refused", await takePictureBytes(folder, 500, 1_000), false);
  is("and nothing stays counted for it", Number(redis.run(["GET", PICTURES_BYTES_KEY(folder)])), 600);
  is("not a whole positive number of bytes: refused", [await takePictureBytes(folder, 0, 1_000), await takePictureBytes(folder, 1.5, 1_000), await takePictureBytes(folder, -3, 1_000)], [false, false, false]);
  is("no figure: refused", await takePictureBytes(folder, 1, 0), false);
  is("a folder that is not one: refused", await takePictureBytes("../x", 1, 1_000), false);

  part("Given back when deleted");
  await givePictureBytes(folder, 600);
  is("given back", Number(redis.run(["GET", PICTURES_BYTES_KEY(folder)])), 0);
  await givePictureBytes(folder, 600);
  is("never below zero", Number(redis.run(["GET", PICTURES_BYTES_KEY(folder)])), 0);

  part("Unknown is refused (rule 24)");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async () => ["not a number"]) as typeof redis.pipeline;
  is("a count that does not read: refused", await takePictureBytes(folder, 1, 1_000), false);
  redis.pipeline = (async () => { throw new Error("down"); }) as typeof redis.pipeline;
  is("no answer: refused", await takePictureBytes(folder, 1, 1_000), false);
  redis.pipeline = real;

  done();
})();
