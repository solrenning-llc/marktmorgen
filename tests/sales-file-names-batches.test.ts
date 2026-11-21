/**
 * The sales file's product names read in batches of their own (Claude 5's MEDIUM on #3129, 6732344981, kept open by
 * Claude 1 and Claude 3 on b83d0bd319): since #3101 sized LISTING_MGET_KEYS by a whole record's worst bytes (5), the
 * names' HMGETs sliced 2,000 names into 400 commands and sent them all at once. A name weighs far less than a record,
 * so the names take their own batch (NAMES_HMGET_FIELDS, from a product's worst names: a title of MAX_TITLE_LENGTH
 * and MAX_OPTIONS options, each unit at six bytes, escaped once more in the reply), and at most LISTING_MGET_PARALLEL
 * of them are in flight at once, as listingsById's own MGETs.
 *
 * What fails here: more HMGETs than 2,000 names need at that batch, more than LISTING_MGET_PARALLEL in flight, a
 * batch whose worst answer passes LISTING_MGET_ANSWER_BYTES, a name read from the record when its copy is there.
 * Synthetic only.
 */
import * as catalogModule from "@/lib/catalog";
import { LISTING_MGET_ANSWER_BYTES, LISTING_MGET_PARALLEL, listingNamesById } from "@/lib/catalog";
import { MAX_PRODUCTS, MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import { MAX_OPTION_LABEL_LENGTH, MAX_OPTIONS } from "@/lib/product-option";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const fields = (catalogModule as Record<string, unknown>).NAMES_HMGET_FIELDS;
  part("A batch of names stays under the answer's ceiling at its worst");
  {
    // A product's names at their heaviest: a title of control characters, MAX_OPTIONS options, each with a
    // 24-character id and a label of control characters (JSON writes each as six bytes, and the reply escapes the
    // value once more).
    const worst = JSON.stringify(["\u0001".repeat(MAX_TITLE_LENGTH), ...Array.from({ length: MAX_OPTIONS }, (_, i) => [`o${String(i).padStart(23, "0")}`, "\u0001".repeat(MAX_OPTION_LABEL_LENGTH)]).flat()]);
    const answer = JSON.stringify(worst).length;
    is("the names take their own batch, a number of fields", typeof fields === "number" && Number.isSafeInteger(fields) && fields >= 1, true);
    is("a batch of names at their worst stays under LISTING_MGET_ANSWER_BYTES", Number(fields) * (answer + 3) <= LISTING_MGET_ANSWER_BYTES, true);
    is("and it holds many names, not the five records an answer holds", Number(fields) >= 50, true);
  }

  part("2,000 names: few HMGETs, never more than LISTING_MGET_PARALLEL in flight");
  {
    const ids = Array.from({ length: MAX_PRODUCTS }, (_, i) => `p${String(i).padStart(6, "0")}`);
    const store = { catalog: { id: "catnames01", items: ids.map((id) => ({ id, kind: 0 })), head: [] } } as unknown as Store;
    for (const id of ids) redis.run(["HSET", "nl:catalog:catnames01:n", id, JSON.stringify([`Title ${id}`])]);
    const original = redis.pipeline.bind(redis);
    let hmget = 0;
    let mget = 0;
    let flying = 0;
    let most = 0;
    redis.pipeline = (async (cmds: (string | number)[][]) => {
      hmget += cmds.filter((c) => c[0] === "HMGET").length;
      mget += cmds.filter((c) => c[0] === "MGET").length;
      flying += 1;
      most = Math.max(most, flying);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await original(cmds);
      } finally {
        flying -= 1;
      }
    }) as typeof redis.pipeline;
    let found: Map<string, unknown> = new Map();
    try {
      found = await listingNamesById(store, ids);
    } finally {
      redis.pipeline = original;
    }
    is("every name read from its copy", [found.size, mget], [MAX_PRODUCTS, 0]);
    is("as many HMGETs as 2,000 names need at the names' batch", hmget, Math.ceil(MAX_PRODUCTS / Number(fields)));
    is("at most LISTING_MGET_PARALLEL requests in flight at once", most <= LISTING_MGET_PARALLEL, true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
