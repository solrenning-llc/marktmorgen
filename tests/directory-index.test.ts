/**
 * The list of creators who agreed to be listed in the affiliate directory
 * (lib/directory-index.ts), which the directory reads instead of scanning
 * every store (app/affiliate-programs, lib/affiliate-directory.ts).
 *
 * The consent was collected before the directory opened, so the index had to
 * be kept in step both ways from the start: a list that only grows stops
 * matching the consents behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DIRECTORY_CACHE,
  INDEX_DIRECTORY_AT,
  forgetListing,
  listedCount,
  listedStores,
  rememberListing,
  wouldList,
} from "@/lib/directory-index";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

function store(sid: string, over: Record<string, unknown> = {}): Store {
  return {
    sid,
    handle: sid,
    name: `Store ${sid}`,
    affiliates: parseAffiliateSetting({ enabled: true, percent: 25, directory: true, ...over }),
  } as unknown as Store;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith(".ts") || rel.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

// ---- who would be listed ------------------------------------------------

test("consent is necessary and not sufficient", () => {
  assert.equal(wouldList(store("a")), true);
  assert.equal(wouldList(store("b", { directory: false })), false, "no consent, no row");
  assert.equal(
    wouldList(store("c", { enabled: false })),
    false,
    "a programme switched off earns an affiliate nothing, so the row would waste their click",
  );
  assert.equal(wouldList({ ...store("d"), sid: "" } as Store), false, "a store with no id cannot be listed");
});

// ---- the index, kept in step both ways ---------------------------------

test("saying yes puts a store in the list", async () => {
  await rememberListing(store("s1"));
  assert.equal(await listedCount(), 1);
});

test("saying yes twice is one store, not two", async () => {
  await rememberListing(store("s1"));
  await rememberListing(store("s1"));
  assert.equal(await listedCount(), 1, "a set, so saving the programme twice does not double the count");
});

test("saying no takes it out again, which is the half that gets forgotten", async () => {
  await rememberListing(store("s1", { directory: false }));
  assert.equal(await listedCount(), 0, "a list that only ever grows stops matching the consents behind it");
});

test("switching the whole programme off takes it out too", async () => {
  await rememberListing(store("s2"));
  assert.equal(await listedCount(), 1);
  await rememberListing(store("s2", { enabled: false }));
  assert.equal(await listedCount(), 0);
});

test("a store being deleted leaves no row behind", async () => {
  await rememberListing(store("s3"));
  await forgetListing("s3");
  assert.equal(await listedCount(), 0);
  await forgetListing("");
  await forgetListing("never-existed");
});

test("the list can be read back, or keeping it was pointless", async () => {
  await rememberListing(store("s4"));
  await rememberListing(store("s5"));
  const { sids } = await listedStores();
  assert.deepEqual(sids.sort(), ["s4", "s5"]);
  await forgetListing("s4");
  await forgetListing("s5");
});

// ---- the page's copy is dropped with every save that can change it ---

test("a save drops the directory's kept rows, so taking a store out is immediate", async () => {
  const { redisPipeline } = await import("@/lib/redis");
  await rememberListing(store("s6"));
  await redisPipeline([["SET", DIRECTORY_CACHE, "[]"]]);
  await rememberListing(store("s6", { directory: false }));
  const [kept] = await redisPipeline([["GET", DIRECTORY_CACHE]]);
  assert.equal(kept, null);
});

test("a save from a store that was not in the listed set and stays out keeps the kept rows (Claude 6 on #3062)", async () => {
  // The state before the save is read from the listed set itself (the SREM reply), not passed in by lib/store.ts.
  const { redisPipeline } = await import("@/lib/redis");
  await redisPipeline([["SET", DIRECTORY_CACHE, "[]"]]);
  await rememberListing(store("s7", { directory: false }));
  await rememberListing(store("s7", { enabled: false }));
  const [kept] = await redisPipeline([["GET", DIRECTORY_CACHE]]);
  assert.equal(kept, "[]", "a store not listed before or after the save changes nothing the directory shows");
});

test("an SREM reply in an unknown shape counts as listed: the kept rows are dropped and the failure is said", async () => {
  const { redisPipeline } = await import("@/lib/redis");
  const { store: redis } = await import("./redis-stub");
  const original = redis.pipeline.bind(redis);
  await redisPipeline([["SET", DIRECTORY_CACHE, "[]"]]);
  for (const reply of ["1", 2, -1, null, [1]]) {
    await redisPipeline([["SET", DIRECTORY_CACHE, "[]"]]);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands[0]?.[0] === "SREM" ? [reply] : original(commands)) as typeof redis.pipeline;
    try {
      await assert.rejects(rememberListing(store("s8", { directory: false })), UnknownReplyError, `SREM answered ${JSON.stringify(reply)}`);
    } finally {
      redis.pipeline = original;
    }
    const [kept] = await redisPipeline([["GET", DIRECTORY_CACHE]]);
    assert.equal(kept, null, `the kept rows are dropped when SREM answered ${JSON.stringify(reply)}`);
  }
});

test("search engines are asked to show it only once there is a catalog", () => {
  assert.ok(INDEX_DIRECTORY_AT >= 5 && INDEX_DIRECTORY_AT <= 50);
});

test("the index is written where the program is saved", () => {
  const source = readFileSync(join(process.cwd(), "lib/store.ts"), "utf8");
  assert.match(source, /rememberListing\(next\)/, "the index has to be kept in step where the programme is saved");
});

test("only the directory and the index read the consent", () => {
  const readers = walk("app")
    .concat(walk("lib"), walk("components"))
    .filter((f) => /affiliates\.directory|listedStores\(|listedCount\(/.test(readFileSync(join(process.cwd(), f), "utf8")))
    .sort();
  assert.deepEqual(readers, ["lib/affiliate-directory.ts", "lib/directory-index.ts"]);
});
