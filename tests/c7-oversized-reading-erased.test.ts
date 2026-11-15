/**
 * Issue #4758 (Codex L, erasure, MEDIUM): keptReading (lib/store-readings.ts) returned a reading too large to keep
 * (above READING_COPY_MAX_BYTES) before the erasure check made where a copy is written (READING_COPY), so a person
 * deleted while the reading was being made was shown by name. Such a reading is now shown with its totals and naming
 * nobody (the guard's `without`, marked `unnamed`), with no Redis call added; one that names nobody, or has no guard,
 * is shown as read. Synthetic data, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { type Store, storeForEmail } from "@/lib/store";
import { READING_COPY_MAX_BYTES, keptReading } from "@/lib/store-readings";
import { suppressCommand } from "@/lib/suppression";
import { normaliseEmail } from "@/lib/auth";
import { OWNER, makeWorld } from "./erasure-world";
import { store as redis } from "./redis-stub";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuyerNumbers } from "@/components/buyer-numbers";
import { done, is, part } from "./check";

type Reading = { total: number; filler: string; names: string[] };

async function main(): Promise<void> {
  redis.clear();
  await makeWorld();
  const store = (await storeForEmail(OWNER)) as Store;
  const listId = store.listId as string;
  const erased = normaliseEmail("erased.during.read@example.com");
  const kept = normaliseEmail("still.here@example.com");
  const guard = {
    listId,
    names: (v: Reading) => v.names,
    without: (v: Reading, gone: Set<string>) => ({ ...v, names: v.names.filter((n) => !gone.has(n)) }),
  };
  const copy = `nl:reading:sales:${store.statsId}`;
  const run = (filler: string, names: string[], withGuard = true) => {
    // Each case a fresh reading on a fresh day's budget: the copy and the day's units are let go first.
    const day = `nl:reading:day:${store.statsId}:${new Date().toISOString().slice(0, 10)}`;
    for (const key of [copy, day, `${day}:heavy`]) redis.run(["DEL", key]);
    return keptReading(store, "sales", async () => {
      // The person's erasure completes while the reading is being made, after it looked at the deleted people.
      await redis.pipeline([suppressCommand(listId, erased)]);
      return { total: 1234, filler, names } as Reading;
    }, Date.now(), true, withGuard ? guard : undefined);
  };
  const big = "x".repeat(READING_COPY_MAX_BYTES + 1);

  part("Control: a reading within the copy limit, a person erased while it was made");
  is("the reading shown does not name the erased person", (await run("x", [erased, kept]))?.value.names, [kept]);

  part("A reading above READING_COPY_MAX_BYTES, the same erasure while it was made");
  let commands = 0;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: (string | number)[][]) => {
    commands += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;
  let oversized;
  try {
    oversized = await run(big, [erased, kept]);
  } finally {
    redis.pipeline = real;
  }
  is("it names nobody, never the erased person, and says why", [oversized?.value.names, oversized?.unnamed, oversized?.tooLarge], [[], true, true]);
  is("its totals are kept, shown fresh, and it is not kept", [oversized?.value.total, oversized?.stale, redis.run(["EXISTS", copy])], [1234, false, 0]);
  // GET of the copy, the day's reading unit, the suppression the test makes: nothing more for the oversized reading.
  const control = { n: 0 };
  redis.pipeline = (async (batch: (string | number)[][]) => {
    control.n += batch.length;
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    await run(big, []);
  } finally {
    redis.pipeline = real;
  }
  is("no Redis call added: as many as an oversized reading naming nobody", commands, control.n);

  part("Oversized readings with nobody to remove are shown as read");
  const nobody = await run(big, []);
  is("naming nobody: whole, not marked", [nobody?.value.total, nobody?.value.names, nobody?.unnamed], [1234, [], undefined]);
  const unguarded = await run(big, [erased], false);
  is("a kind with no guard names nobody by address: shown as read", [unguarded?.value.total, unguarded?.unnamed], [1234, undefined]);

  part("The studio says why, and never that they come back on their own");
  const windows = { d7: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 }, d30: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 }, d90: { buyers: 2, orders: 2, cents: 5_000, returning: 0, repeat: 0 } };
  const shown = renderToStaticMarkup(createElement(BuyerNumbers, { windows, range: "d90", span: "90 days", currency: "usd", top: [], buyersLater: "too-large" } as never)).replace(/\s+/g, " ");
  is("too large: said plainly, no promise of when",
    [shown.includes("Your biggest buyers are not shown this time. These numbers are too large for us to check them against people who asked us to delete their details."), shown.includes("show here again")], [true, false]);
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio page passes the reason on", /salesRead\.tooLarge \? \("too-large" as const\)/.test(page), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
