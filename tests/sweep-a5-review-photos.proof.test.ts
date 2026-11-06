/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/reviews.ts dropReviews, lines 664-667:
 *   const [raw, all] = await redisPipeline([["HKEYS", key], ["HVALS", key]]);
 *   const ids = Array.isArray(raw) ? raw : [];
 *   const photos = (Array.isArray(all) ? all : []).map(...photo.path);
 * then DELs the product's reviews. An HVALS answered in an unknown shape reads as "no photos": the review records
 * are deleted and the list of their photos returned to the product route (app/api/store/product/route.ts:327) is
 * empty, so the buyers' review photos stay in the picture folder with nothing left that names them. An HKEYS
 * answered unknown likewise leaves the all/new index entries of the deleted reviews behind.
 */
import { dropReviews, readReview } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const statsId = "ab".repeat(16);
const productId = "prod00000001";
const folder = "ef".repeat(12);
const original = redis.pipeline.bind(redis);

async function seed(productId: string) {
  const out: string[] = [];
  for (const n of [1, 2]) {
    const id = String(n).repeat(24);
    const path = `images/${folder}/${String(n).repeat(32)}.webp`;
    out.push(path);
    await redis.pipeline([
      ["HSET", `nl:rev:${statsId}:${productId}`, id, JSON.stringify({ id, productId, rating: 5, text: "Good", name: "Ana", createdAt: 1, photo: { path, width: 800, height: 800 } })],
    ]);
  }
  return out;
}

async function main() {
  redis.clear();
  part("Healthy control: dropping a product's reviews hands back their photos for deletion");
  const paths = await seed(productId);
  is("the seeded review reads back with its photo", (await readReview(statsId, productId, "1".repeat(24)))?.photo?.path, paths[0]);
  is("both photos handed back", (await dropReviews(statsId, productId, 1)).sort(), paths);

  part("DEFECT: the same drop, the HVALS answered in an unknown shape");
  const pid2 = "prod00000002";
  await seed(pid2);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 2 && commands[0][0] === "HKEYS" && commands[1][0] === "HVALS") { const r = await original(commands); return [r[0], null]; }
    return original(commands);
  }) as typeof redis.pipeline;
  const dropped = await dropReviews(statsId, pid2, 1);
  redis.pipeline = original;
  is("DEFECT: no photo is handed back", dropped, []);
  is("DEFECT: while the review records that named them are deleted", (await redis.pipeline([["EXISTS", `nl:rev:${statsId}:${pid2}`]]))[0], 0);
  done();
}
main();
