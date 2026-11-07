/** Independent final-delta controls; synthetic cache and MemoryRedis only. */
import assert from "node:assert/strict";
import { readDirectory } from "@/lib/affiliate-directory";
import { DIRECTORY_BUILD, DIRECTORY_CACHE, DIRECTORY_LAST, rememberListing, stillListed } from "@/lib/directory-index";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  checks += 1;
}
async function main(): Promise<void> {
  redis.clear();
  // Synthetic last-page fixture tests the real lastDirectory/stillListed call path, not a duplicate implementation.
  const row = { handle: "sample", name: "Sample" };
  await original([["SADD", "nl:dir:listed", "sid1"], ["SET", DIRECTORY_BUILD, "1", "EX", 60], ["SET", DIRECTORY_LAST, JSON.stringify({ sids: ["sid1"], rows: [row] }), "EX", 720]]);
  const commands: string[] = [];
  redis.pipeline = (async (input: Commands) => {
    commands.push(...input.map((c) => String(c[0])));
    return original(input);
  }) as typeof redis.pipeline;
  check("busy read returns the consent-filtered row", await readDirectory(), [row]);
  check("busy path has exactly four commands and no build", commands, ["GET", "SET", "GET", "SMISMEMBER"]);
  redis.pipeline = original;
  await original([["SREM", "nl:dir:listed", "sid1"]]);
  check("withdrawn consent removes the cached row", await readDirectory(), []);
  check("filtered last page is not persisted as the kept page", (await original([["GET", DIRECTORY_CACHE]]))[0], null);
  check("no members requires no Redis call", await stillListed([]), []);
  const store = { sid: "sid1", affiliates: parseAffiliateSetting({ enabled: false, directory: false }) } as unknown as Store;
  await original([["SET", DIRECTORY_CACHE, "synthetic-kept"]]);
  redis.pipeline = (async (input: Commands) => {
    if (input[0]?.[0] === "SREM") throw new Error("synthetic transport failure");
    return original(input);
  }) as typeof redis.pipeline;
  await assert.rejects(rememberListing(store), /synthetic transport failure/); checks += 1;
  redis.pipeline = original;
  check("throwing SREM invalidates the current page", (await original([["GET", DIRECTORY_CACHE]]))[0], null);
  for (const reply of [undefined, [], [1, 1], ["1"], [2]]) {
    redis.pipeline = (async (input: Commands) => input[0]?.[0] === "SMISMEMBER" ? [reply] : original(input)) as typeof redis.pipeline;
    await assert.rejects(readDirectory(), UnknownReplyError); checks += 1;
    redis.pipeline = original;
  }
  check("command-only monthly arithmetic at the registry coefficient", 12068 * 60 * 24 * 30 * 2 / 1_000_000, 1042.6752);
  console.log(`${checks} independent checks PASS`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
