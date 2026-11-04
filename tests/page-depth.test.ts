/**
 * How far down a sales page visitors read (lib/page-depth.ts). What is
 * checked: a block's share is everybody who stopped at it or further; blocks
 * removed since are not shown; counting needs a real block id.
 */
import { countDepth, reachShares, readDepth } from "@/lib/page-depth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  part("Shares");
  const { shares } = reachShares(["hero0001", "bene0001", "faqs0001"], { hero0001: 50, bene0001: 30, faqs0001: 20, gone0001: 5 }, 100);
  is("everybody reached the top", shares.hero0001, 100);
  is("those who stopped here or further", shares.bene0001, 50);
  is("the last block", shares.faqs0001, 20);
  is("a removed block is not shown", shares.gone0001, undefined);

  part("Counting");
  await countDepth("s1", "p1", "bene0001");
  await countDepth("s1", "p1", "bene0001");
  await countDepth("s1", "p1", "<script>");
  is("counted, and nothing that is not a block id", await readDepth("s1", "p1"), { visitors: 2, stopped: { bene0001: 2 }, whyNot: {}, videos: {}, time: {} });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
