/** Assistant-note deletion cost traceability. Real helpers; synthetic Redis and clock only. */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { MAX_STORED_MEMORY_BYTES, MEMORY_FORGET_COMMANDS, forgetMemory } from "@/lib/assistant-memory-store";
import { FORGET_PER_RUN, FORGET_TRIES, retryStoreForgets } from "@/lib/store-forget-retry";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";
import { COST_LINES, NOT_A_COST } from "./plan-cost-registry";

const classifiedNames = ["MEMORY_FORGET_COMMANDS", "FORGET_TRY_COMMANDS", "FORGET_TRIES", "FORGET_PER_RUN"];
function hasDeletionClassifications(entries: Record<string, string>): boolean {
  return classifiedNames.every(name => Object.hasOwn(entries, name));
}

type Command = (string | number)[];
const originalPipeline = redis.pipeline.bind(redis);
const commands: Command[] = [];
let replyBytes = 0;
redis.pipeline = (async (batch: Command[]) => {
  commands.push(...batch);
  const result = await originalPipeline(batch);
  replyBytes += Buffer.byteLength(JSON.stringify(result));
  return result;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  const statsId = "z-memory-cost";
  const savedNow = Date.now;
  const savedRandom = Math.random;
  const savedTimeout = globalThis.setTimeout;
  let now = Date.UTC(2026, 10, 6);
  redis.clear();
  Date.now = () => now;
  Math.random = () => 0;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    now += Number(delay ?? 0);
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await originalPipeline([
      ["SET", `nl:amem:${statsId}`, "x".repeat(MAX_STORED_MEMORY_BYTES)],
      ["SET", `nl:amem:lock:${statsId}`, "another-operation", "EX", 10],
    ]);
    commands.length = 0;
    replyBytes = 0;
    await forgetMemory(statsId, ROOM);
    is("maximum declared stored record is 55,264 bytes", MAX_STORED_MEMORY_BYTES, 55_264);
    is("the real bounded lock path attempts eleven SETs", commands.filter(c => c[0] === "SET").length, 11);
    is("external dispatches are fourteen: eleven lock attempts and three EVALs", commands.length, 14);
    is("the declared sixteen is an outer-dispatch ceiling, not a Lua invoice proof", commands.length <= MEMORY_FORGET_COMMANDS, true);
    is("the record is actually removed", (await originalPipeline([["GET", `nl:amem:${statsId}`]]))[0], null);
    console.log("Observed forgetMemory external dispatches / JSON-serialized stub reply bytes (not RESP, wire or billed bytes):", commands.length, replyBytes);
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
    globalThis.setTimeout = savedTimeout;
  }

  // A work cap does not cap the preceding HGETALL. This observation does not
  // invent a funded byte ceiling or claim an unknown company cost is zero.
  redis.clear();
  const rows = 2_000;
  const fields: string[] = [];
  for (let i = 0; i < rows; i++) fields.push(`stats${i}|${i.toString(16).padStart(32, "0")}`, JSON.stringify({ tries: 1, first: 1, last: 1 }));
  await originalPipeline([["HSET", "nl:forget:q", ...fields]]);
  commands.length = 0;
  replyBytes = 0;
  let worked = 0;
  const result = await retryStoreForgets(0, Date.now(), async () => { worked += 1; });
  is("expired work deadline still reads all two thousand queue rows", [commands.length, commands[0][0], result.left, worked], [1, "HGETALL", rows, 0]);
  is("the work caps remain eight tries and twenty-five stores", [FORGET_TRIES, FORGET_PER_RUN], [8, 25]);
  console.log("Observed retry queue rows / external dispatches / JSON-serialized stub reply bytes (not RESP, wire or billed bytes):", rows, commands.length, replyBytes);
  const route = readFileSync("app/api/store/stores/route.ts", "utf8");
  const admission = route.indexOf('creatorFrom(request, "delete")');
  is("the store-deletion caller follows the essential delete admission", admission >= 0 && admission < route.indexOf("await forgetMemory("), true);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("the company retry and assistant-delete sources are explicitly classified, with unknown funding preserved", ["MEMORY_FORGET_COMMANDS", "FORGET_TRY_COMMANDS", "FORGET_TRIES", "FORGET_PER_RUN"].every(name => registry.includes(name)), true);
  const paths = execFileSync("git", ["grep", "-l", "-E", "forgetMemory[[:space:]]*\\(", "--", "app", "lib"], { encoding: "utf8", maxBuffer: 8192 }).trim().split("\n");
  const callers = paths.filter(path => /\bforgetMemory\s*\(/.test(readFileSync(path, "utf8").replace(/\bfunction\s+forgetMemory\s*\(/g, "function declaration("))).sort();
  is("all direct production callers are inventoried", callers, ["app/api/store/assistant-memory/route.ts", "app/api/store/stores/route.ts", "lib/store-forget-retry.ts"]);
  const studio = COST_LINES.find(line => line.id === "studio");
  is("the live-store forget route is cited by the studio cost line", studio?.sources.some(source => source.file === "app/api/store/assistant-memory/route.ts" && source.names.includes("guardStoreWrite") && source.names.includes("forgetMemory")), true);
  is("the shared constant classifies live-store and company callers separately", ["app/api/store/assistant-memory/route.ts", "app/api/store/stores/route.ts", "lib/store-forget-retry.ts"].every(path => NOT_A_COST.MEMORY_FORGET_COMMANDS.includes(path)), true);
  is("all four explicit classification keys are present", hasDeletionClassifications(NOT_A_COST), true);
  const omitted = { ...NOT_A_COST };
  delete omitted.MEMORY_FORGET_COMMANDS;
  is("a name mentioned by another entry cannot replace its own classification key", hasDeletionClassifications(omitted), false);
  is("the queue sample is explicitly serialized stub JSON, not billed transport bytes", NOT_A_COST.FORGET_PER_RUN.includes("JSON-serialized stub reply") && NOT_A_COST.FORGET_PER_RUN.includes("not RESP, wire or billed bytes"), true);
  done();
}

main();
