import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneResearch, RESPONSES_KEY } from "@/lib/creator-research-store";
import { store } from "./redis-stub";

const now = Date.parse("2026-11-06T00:00:00.000Z");
const keep = 730 * 24 * 60 * 60 * 1000;
const expired = JSON.stringify({ createdAt: new Date(now - keep).toISOString(), problem: "Synthetic answer" });
const recent = JSON.stringify({ createdAt: new Date(now - keep + 1).toISOString() });
const pipeline = store.pipeline.bind(store);
type Command = (string | number)[];

async function world(run: (commands: Command[][]) => Promise<void>, reply?: (command: Command, index: number) => unknown | Promise<unknown>) {
  await pipeline([["DEL", RESPONSES_KEY]]);
  await pipeline([["LPUSH", RESPONSES_KEY, expired]]);
  const commands: Command[][] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
  store.pipeline = async batch => {
    commands.push(batch);
    if (reply) return await reply(batch[0], commands.length - 1) as unknown[];
    return pipeline(batch);
  };
  try { await run(commands); }
  finally { store.pipeline = pipeline; globalThis.fetch = fetch; await pipeline([["DEL", RESPONSES_KEY]]); }
}

const malformed: [string, unknown][] = [
  ["missing result", []], ["undefined slot", [undefined]], ["hole", Array(1)],
  ["extra result", [null, null]], ["boolean slot", [false]], ["object slot", [{}]],
  ["array slot", [[]]], ["number slot", [0]],
];

for (const [name, raw] of malformed) {
  test(`an unreadable oldest answer is not confirmed absence: ${name}`, async () => {
    await world(async commands => {
      await assert.rejects(pruneResearch(now));
      assert.deepEqual(commands, [[["LINDEX", RESPONSES_KEY, -1]]]);
      assert.deepEqual(await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [[expired]]);
    }, () => raw);
  });
}

for (const [name, raw] of [...malformed.filter(([name]) => name !== "number slot"), ["null receipt", [null]], ["string receipt", ["1"]], ["too many removals", [2]], ["negative receipt", [-1]], ["fractional receipt", [0.5]], ["nonfinite receipt", [NaN]]] as [string, unknown][]) {
  test(`an unreadable removal is not counted as a deletion: ${name}`, async () => {
    await world(async commands => {
      await assert.rejects(pruneResearch(now));
      assert.deepEqual(commands, [[["LINDEX", RESPONSES_KEY, -1]], [["LREM", RESPONSES_KEY, -1, expired]]]);
      assert.deepEqual(await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [[expired]]);
    }, (command, index) => index === 0 ? [expired] : command[0] === "LREM" ? raw : [null]);
  });
}

test("confirmed absence and the exact retention boundary use the real list", async () => {
  await world(async commands => {
    await pipeline([["LPUSH", RESPONSES_KEY, recent]]);
    assert.equal(await pruneResearch(now), 1);
    assert.deepEqual(await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [[recent]]);
    assert.equal(commands.length, 3);
    await pipeline([["DEL", RESPONSES_KEY]]);
    assert.equal(await pruneResearch(now), 0);
  });
});

test("a concurrent confirmed removal of zero is not counted", async () => {
  await world(async commands => {
    assert.equal(await pruneResearch(now), 0);
    assert.equal(commands.length, 3);
  }, async (command, index) => {
    if (index === 0) return [expired];
    if (command[0] === "LREM") {
      await pipeline([["LREM", RESPONSES_KEY, -1, expired]]); // The other pruner removes it first.
      return pipeline([command]);
    }
    return pipeline([command]);
  });
});

test("an applied removal with a lost receipt stays unknown without retrying", async () => {
  await world(async commands => {
    store.pipeline = async batch => {
      commands.push(batch);
      const result = await pipeline(batch);
      return batch[0][0] === "LREM" ? [] : result;
    };
    await assert.rejects(pruneResearch(now));
    assert.equal(commands.length, 2);
    assert.deepEqual(await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [[]]);
  });
});

test("the existing 500-answer bound and unreadable-answer retention policy remain", async () => {
  await world(async commands => {
    await pipeline([["DEL", RESPONSES_KEY], ["LPUSH", RESPONSES_KEY, ...Array<string>(501).fill("synthetic unreadable answer")]]);
    assert.equal(await pruneResearch(now), 500);
    assert.equal(commands.length, 1000);
    assert.deepEqual(await pipeline([["LRANGE", RESPONSES_KEY, 0, -1]]), [["synthetic unreadable answer"]]);
  });
});
