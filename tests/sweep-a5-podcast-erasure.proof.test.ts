/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/podcast-access.ts forgetPodcastPerson, lines 166-173:
 *   const tokens = await redisPipeline(productIds.map((p) => ["GET", byKey(sid, p, email)]));
 *   const held = tokens.filter((t): t is string => typeof t === "string" && FEED_TOKEN.test(t));
 *   const [gone] = await redisPipeline([["DEL", ...byKeys, ...okKeys, ...held.map(tokenKey)]]);
 *   return Number(gone) || 0;
 * A GET pipeline answered short or in another shape leaves `held` empty: the person's index keys are deleted, but
 * the feed grant nl:pod:t:<sha(token)>, which holds their email address, is kept, and with the index gone nothing can
 * find it again. The erasure step (lib/person-erasure.ts:163) answers a number and does not throw, so the module is
 * counted as done while the address stays stored and the private feed address keeps resolving to it.
 */
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { feedToken, forgetPodcastPerson, readFeedToken } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";
const original = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  const show = await addProduct(OWNER, "Sourdough Radio", "", "19", null);
  if (!show.ok) throw new Error("no product");
  const pid = show.product.id;
  const store = async () => (await storeForEmail(OWNER))!;

  part("Healthy control: erasing a listener deletes their feed grant");
  const t1 = (await feedToken(await store(), pid, "ana@example.com"))!;
  is("the grant holds the address", (await readFeedToken(t1))?.e, "ana@example.com");
  const n1 = await forgetPodcastPerson(await store(), [pid], "ana@example.com");
  is("erased: index and grant gone", [n1 >= 2, await readFeedToken(t1)], [true, null]);

  part("DEFECT: the same erasure, the GET of the person's feed token answered in an unknown shape");
  for (const [label, reply] of [["no reply", () => []], ["a number", () => [5]]] as const) {
    const email = `ben-${label.replace(/\s/g, "")}@example.com`;
    const t2 = (await feedToken(await store(), pid, email))!;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:pod:by:")) return reply();
      return original(commands);
    }) as typeof redis.pipeline;
    let threw = false;
    const n2 = await forgetPodcastPerson(await store(), [pid], email).catch(() => { threw = true; return -1; });
    redis.pipeline = original;
    is(`DEFECT (${label}): the erasure step answers a count and does not throw`, [threw, typeof n2], [false, "number"]);
    is(`DEFECT (${label}): the feed grant with the erased address is still stored and resolves`, (await readFeedToken(t2))?.e, email);
    is(`DEFECT (${label}): and the index that could find it again is gone`, (await feedToken(await store(), pid, email)) === t2, false);
  }
  done();
}
main();
