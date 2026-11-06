/** Independent review proof for #3009: an invalid HGET read-back is unknown, not "another run's mark". */
import { startClosingCredit } from "@/lib/closing-credit";
import { tellBuyers, toldKey } from "@/lib/closing-buyers";
import { workKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

  const owner = "review-3009@example.com";
  await claimHandle(owner, "review3009", "Review 3009", "");
  const store = await storeForEmail(owner);
  if (!store) throw new Error("store setup failed");
  const folder = await storeFolder(storeRef(store));
  const told = toldKey(folder);
  await pipeline([["HSET", workKey(folder), "m:sub_review3009", "member@example.com"]]);
  await startClosingCredit(folder, 0);

  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HSETNX" && commands[0]?.[1] === told) {
      await pipeline(commands); // The write landed, but its reply was lost.
      return ["?"];
    }
    if (commands[0]?.[0] === "HGET" && commands[0]?.[1] === told) {
      return ["x:zz"]; // Neither a timestamp nor an old/new untold mark.
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;

  part("Invalid HGET read-back after an unknown HSETNX receipt");
  let rejected = false;
  try {
    await tellBuyers(store, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), "", Date.now() + 60_000);
  } catch (error) {
    rejected = error instanceof UnknownReplyError;
  }
  is("the invalid read-back is unknown and holds the closing", rejected, true);
  redis.pipeline = pipeline;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
