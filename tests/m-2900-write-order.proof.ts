/**
 * Review #2900: actual Today page and async components, actual in-memory Redis.
 * The async tree walker is credited to tests/studio-today-trips.test.ts:45–58.
 * No business module or Redis reply is replaced. A4 and the PR use identical assertions.
 * Admitted ceiling: 3 cases/run, 3,000 explicit commands/case including setup,
 * <=9,000/run (two runs <=18,000), no fetch, uniform 5 ms per pipeline.
 */
import { isValidElement } from "react";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import StudioPage from "@/app/studio/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Reading = {
  commands: number; trips: number; cacheReads: number; cacheWrites: number;
  listingGets: number; readsBeforeFirstWrite: number; cacheEvents: string[];
};
const blank = (): Reading => ({ commands: 0, trips: 0, cacheReads: 0, cacheWrites: 0, listingGets: 0, readsBeforeFirstWrite: 0, cacheEvents: [] });
const CASE_CAP = 3_000;
const RUN_CAP = 9_000;
const DELAY_MS = 5;

// Same traversal as the author's measurement, including sibling promises and async components.
async function render(node: unknown): Promise<void> {
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node);
  if (Array.isArray(node)) { await Promise.all(node.map(render)); return; }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props));
  await Promise.all(Object.values(props).map(render));
}

function cacheSnapshot(reply: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  if (!Array.isArray(reply) || reply.length % 2 !== 0) throw new Error("Cache snapshot was not an exact flat hash reply");
  for (let i = 0; i < reply.length; i += 2) {
    if (typeof reply[i] !== "string" || typeof reply[i + 1] !== "string") throw new Error("Cache snapshot contained a non-string field");
    out[reply[i]] = JSON.parse(reply[i + 1]);
  }
  return out;
}

async function main(): Promise<void> {
  const originalPipeline = redis.pipeline;
  const originalFetch = globalThis.fetch;
  let caseCommands = 0;
  let runCommands = 0;
  let fetchAttempts = 0;
  let measuring = false;
  let cacheKey = "";
  let listingPrefix = "";
  let stats = blank();
  const summaries: unknown[] = [];
  globalThis.fetch = (async () => { fetchAttempts += 1; throw new Error("Review proof blocks every fetch"); }) as typeof fetch;
  redis.pipeline = async (commands: Command[]) => {
    // Reserve/count every explicit command BEFORE the real pipeline invocation.
    if (caseCommands + commands.length > CASE_CAP || runCommands + commands.length > RUN_CAP) throw new Error("Review command ceiling reached before invocation");
    caseCommands += commands.length;
    runCommands += commands.length;
    if (measuring) {
      stats.commands += commands.length;
      stats.trips += 1;
      for (const command of commands) {
        const op = String(command[0]).toUpperCase();
        const key = String(command[1] ?? "");
        if (op === "HGETALL" && key === cacheKey) {
          stats.cacheReads += 1;
          if (!stats.cacheWrites) stats.readsBeforeFirstWrite += 1;
          stats.cacheEvents.push("HGETALL");
        }
        if (op === "HSET" && key === cacheKey) { stats.cacheWrites += 1; stats.cacheEvents.push("HSET"); }
        if (op === "GET" && key.startsWith(listingPrefix)) stats.listingGets += 1;
      }
    }
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    return originalPipeline.call(redis, commands);
  };
  try {
    redis.clear();
    const owner = "review-today@example.test";
    await claimHandle(owner, "reviewtoday", "Review Today", "");
    await ensureStatsId(owner);
    const paid = await addProduct(owner, "Paid guide", "", "19", null);
    const free = await addProduct(owner, "Free guide", "", "0", null);
    if (!paid.ok || !free.ok) throw new Error("Public product setup failed");
    const session = await openSession(owner);
    const request = () => new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } });
    const open = async () => { answering(request()); await render(await StudioPage({ searchParams: Promise.resolve({}) })); };
    await open(); // Real complete warm-up; its commands remain in the first case's budget.
    const store = await storeForEmail(owner);
    if (!store?.catalog.id || store.catalog.inline) throw new Error("Public setup did not create a persisted catalog");
    cacheKey = `nl:catalog:${store.catalog.id}:t`;
    listingPrefix = `nl:catalog:${store.catalog.id}:l:`;
    const expected: Record<string, unknown> = {
      [paid.product.id]: ["Paid guide", 1900, 0],
      [free.product.id]: ["Free guide", 0, 0],
    };
    for (const scenario of ["cold", "warm", "stale"] as const) {
      if (scenario !== "cold") caseCommands = 0;
      if (scenario === "cold") await redis.pipeline([["DEL", cacheKey]]);
      if (scenario === "stale") await redis.pipeline([["HSET", cacheKey, paid.product.id, JSON.stringify("legacy-title-only")]]);
      stats = blank();
      let loaded = true;
      measuring = true;
      try { await open(); }
      catch (error) { loaded = false; console.error(error instanceof Error ? error.message : "Page failed"); }
      finally { measuring = false; }
      const [raw] = await redis.pipeline([["HGETALL", cacheKey]]);
      const snapshot = cacheSnapshot(raw);
      const healthy = Object.keys(snapshot).length === 2 && Object.keys(expected).every(id => JSON.stringify(snapshot[id]) === JSON.stringify(expected[id]));
      part(`Review Today: ${scenario}`);
      is("the real owner page and its async tree load", loaded, true);
      is("the final card cache matches both real products", healthy, true);
      is("a cold or stale card cache is healed no more than once", stats.cacheWrites <= 1, true);
      if (scenario === "warm") is("a healthy warm cache is not rewritten", stats.cacheWrites, 0);
      is("no fetch is attempted", fetchAttempts, 0);
      summaries.push({ scenario, ...stats, caseCommands, runCommands, healthy, fetchAttempts });
    }
  } finally {
    redis.pipeline = originalPipeline;
    globalThis.fetch = originalFetch;
    answering(null);
  }
  console.log("M_2900_WRITE_ORDER:" + JSON.stringify({ summaries, totalCommands: runCommands, fetchAttempts, delayMs: DELAY_MS }));
  done();
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Harness failed"); process.exitCode = 1; });
