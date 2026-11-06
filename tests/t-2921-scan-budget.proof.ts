/** Opt-in causal scan-budget evidence; no production limits or readers are changed. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readDirectory } from "@/lib/affiliate-directory";
import { store as redis } from "./redis-stub";

declare global {
  var __t2921: { commands: number; scans: number; networkAttempts: number; commandCeiling: number; pageCeiling: number };
}

type Scenario = "short" | "unique" | "repeated";
let scenario: Scenario = "short";
let page = 0;
const originalPipeline = redis.pipeline.bind(redis);
redis.pipeline = async commands => {
  const metrics = globalThis.__t2921;
  const scanCommands = commands.filter(command => command[0] === "SSCAN").length;
  if (metrics.commands + commands.length > metrics.commandCeiling || metrics.scans + scanCommands > metrics.pageCeiling) {
    throw new Error("Synthetic pre-dispatch command/page ceiling");
  }
  metrics.commands += commands.length;
  metrics.scans += scanCommands;
  const replies = await originalPipeline(commands);
  return replies.map((reply, index) => {
    const command = commands[index];
    if (command[0] !== "SSCAN") return reply;
    assert.equal(command[1], "nl:dir:listed");
    assert.equal(command[2], String(page));
    page++;
    const finalPage = scenario === "repeated" ? 3501 : scenario === "unique" ? 2 : 1;
    const members = scenario === "unique"
      ? [(page * 2 - 1).toString(16).padStart(32, "0"), (page * 2).toString(16).padStart(32, "0")]
      : ["a".repeat(32), "b".repeat(32)];
    return [page === finalPage ? "0" : String(page), members];
  });
};

async function observe(mode: Scenario) {
  redis.clear(); // Known absent store references, not unknown transport replies.
  scenario = mode;
  page = 0;
  const before = { ...globalThis.__t2921 };
  const rows = await readDirectory();
  assert.deepEqual(rows, []);
  const result = { scenario: mode, pages: page, scans: globalThis.__t2921.scans - before.scans, commands: globalThis.__t2921.commands - before.commands };
  assert.equal(result.pages, result.scans);
  console.log("T_2921_CASE " + JSON.stringify(result));
  return result;
}

test("short known SSCAN reply terminates and counts all real reader commands", async () => {
  const result = await observe("short");
  assert.equal(result.scans, 1);
  assert.equal(result.commands, 5); // cache GET + scan + two known-missing store GETs + cache SET.
});

test("two pages of unique members terminate under the same reader", async () => {
  const result = await observe("unique");
  assert.equal(result.scans, 2);
  assert.equal(result.commands, 8);
});

test("populated repeated pages preserve the former 2000-returned-member stopping work", async () => {
  const result = await observe("repeated");
  // Identical finite replies on both snapshots: two repeated members per page;
  // numeric cursors and a terminal zero at page 3501. Empty pages are excluded.
  assert.ok(result.scans <= 1000, `former populated-page stopping work was exceeded: ${result.scans} SSCAN calls, ${result.commands} total commands`);
  assert.ok(result.commands <= 3002, `former measured total was exceeded: ${result.commands}`);
});

process.once("exit", () => console.log("T_2921_METRICS " + JSON.stringify(globalThis.__t2921)));
