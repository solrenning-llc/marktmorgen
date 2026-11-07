import { readPathCounts } from "@/lib/path-facts";
import { readLifeRecord } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
const id = "u3076negativeview";
const key = `nl:stats:${id}:life`;
const shop = { statsId: id, handle: id } as Store;
async function main() {
  const real = redis.pipeline.bind(redis);
  await real([
    ["HSET", key, "started", "2026-11-07", "since", "2026-11-07", "filled", "2026-11-07", "r:instagram", "4", "u", "3", "vgap", "0", "cm:usd", "-100"],
    ["HSET", `nl:slink:store:${id}`, "a", "{}"],
  ]);
  const before = await readPathCounts(shop);
  is("healthy social and visitor counts", [before?.social, before?.visitors, before?.links], [4, 3, 1]);
  is("signed currency amount remains readable", (await readLifeRecord(id)).get("cm:usd"), -100);
  redis.pipeline = (async commands => {
    const result = await real(commands);
    if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === key) {
      const flat = [...result[0] as string[]];
      flat[flat.indexOf("r:instagram") + 1] = "-4";
      return [flat];
    }
    return result;
  }) as typeof redis.pipeline;
  const malformed = await readPathCounts(shop);
  redis.pipeline = real;
  is("negative visit count is unknown, not zero social visits", malformed, null);
  const after = await readPathCounts(shop);
  is("underlying healthy record was not modified", [after?.social, after?.visitors, after?.links], [4, 3, 1]);
  done();
}
void main();
