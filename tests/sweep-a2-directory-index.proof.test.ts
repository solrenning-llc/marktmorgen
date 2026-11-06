/**
 * Sweep A2 proof (CX-123 rule 24), synthetic only. lib/directory-index.ts:
 *   listedCount, lines 68-72: `Number(count) || 0`;
 *   listedStores, lines 80-88: `Array.isArray(reply) ? reply : []`, `next: ... : "0"`, `sids: ... : []`.
 * An unknown SCARD/SSCAN reply is "no program listed" and "walk finished": lib/affiliate-directory.ts readDirectory
 * then builds the public directory from no stores and keeps that empty page (SET nl:dir:page "[]", EX 600) for
 * every visitor for ten minutes; the page counts 0 programs. Self-correcting after the cache expires.
 */
import { DIRECTORY_CACHE, listedCount, listedStores } from "@/lib/directory-index";
import { readDirectory } from "@/lib/affiliate-directory";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
async function main() {
  redis.clear();
  await original([["SADD", "nl:dir:listed", "sid_one", "sid_two"]]);
  part("Healthy control");
  is("two listed, both sids read", [await listedCount(), (await listedStores()).sids.sort()], [2, ["sid_one", "sid_two"]]);
  part("DEFECT: SCARD / SSCAN answer in an unknown shape");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SCARD" || commands[0]?.[0] === "SSCAN") return [];
    return original(commands);
  }) as typeof redis.pipeline;
  const count = await listedCount();
  const page = await listedStores();
  const rows = await readDirectory();
  redis.pipeline = original;
  is("DEFECT: 0 listed, no sid, walk 'finished'", [count, page], [0, { next: "0", sids: [] }]);
  is("DEFECT: the public directory is built empty and cached as such", [rows, (await original([["GET", DIRECTORY_CACHE]]))[0]], [[], "[]"]);
  done();
}
main();
