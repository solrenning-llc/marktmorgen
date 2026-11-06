/**
 * CX-123 rule 24 on the public transparency page (624 [SZ8](47),
 * app/transparency/page.tsx, lib/transparency.ts): a Redis reply that is
 * missing, cut short or of another shape is unknown, never "nothing counted
 * yet" and never a count of zero. The page then says the counts could not be
 * loaded just now, and never states a number or "No notice has been counted
 * yet" that it did not read.
 */
import { renderToStaticMarkup } from "react-dom/server";
import TransparencyPage from "@/app/transparency/page";
import { countNotice, transparencyCounts } from "@/lib/transparency";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** Answers the GET of the start day, or each year's HGETALL, with `reply` instead of what is kept. */
function answer(command: "GET" | "HGETALL", reply: (count: number) => unknown): void {
  redis.pipeline = (async (batch: Command[]) => {
    if (batch.every((c) => c[0] === command)) return reply(batch.length);
    return real(batch);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real as typeof redis.pipeline;
};

async function outcome(): Promise<string> {
  try {
    await transparencyCounts(Date.UTC(2026, 10, 3));
    return "read";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function page(): Promise<string> {
  return renderToStaticMarkup(await TransparencyPage());
}

async function main(): Promise<void> {
  redis.clear();
  await countNotice("copyright", Date.UTC(2026, 0, 15));
  await countNotice("other", Date.UTC(2026, 10, 3));
  is("the counts as kept are read", (await transparencyCounts(Date.UTC(2026, 10, 3))).years[0].notices, { copyright: 1, other: 1 });

  part("The start day in an unknown shape is unknown, never 'nothing counted yet'");
  const days: [string, (n: number) => unknown][] = [
    ["a cut-short pipeline", () => []],
    ["a number", () => [20261015]],
    ["an object", () => [{ day: "2026-01-15" }]],
    ["a list", () => [["2026-01-15"]]],
    ["not a day", () => ["soon"]],
    ["not a list at all", () => ({ 0: "2026-01-15" })],
  ];
  for (const [name, reply] of days) {
    answer("GET", reply);
    is(`${name}: unknown`, await outcome(), "unknown");
    restore();
  }

  part("A year's counts in an unknown shape are unknown, never zero");
  const years: [string, (n: number) => unknown][] = [
    ["a cut-short pipeline", (n) => Array.from({ length: n - 1 }, () => [])],
    ["null for a year", (n) => Array.from({ length: n }, () => null)],
    ["a string for a year", (n) => Array.from({ length: n }, () => "notice:copyright")],
    ["an odd list", (n) => Array.from({ length: n }, () => ["notice:copyright"])],
    ["a count that is not a number", (n) => Array.from({ length: n }, () => ["notice:copyright", "many"])],
    ["a negative count", (n) => Array.from({ length: n }, () => ["notice:copyright", "-3"])],
    ["a number in the list", (n) => Array.from({ length: n }, () => ["notice:copyright", 3])],
  ];
  for (const [name, reply] of years) {
    answer("HGETALL", reply);
    is(`${name}: unknown`, await outcome(), "unknown");
    restore();
  }
  answer("HGETALL", (n) => Array.from({ length: n }, () => []));
  is("an empty hash is a year with nothing counted, as kept", (await transparencyCounts(Date.UTC(2026, 10, 3))).years[0].notices, { copyright: 0, other: 0 });
  restore();

  part("The page says it could not load the counts, and states none");
  const unloaded = "The counts could not be loaded just now.";
  answer("GET", () => [7]);
  let html = await page();
  is("an unknown start day: the page says so", html.includes(unloaded), true);
  is("an unknown start day: never 'No notice has been counted yet'", html.includes("No notice has been counted yet"), false);
  restore();
  answer("HGETALL", (n) => Array.from({ length: n }, () => null));
  html = await page();
  is("unknown years: the page says so", [html.includes(unloaded), html.includes("Counted from")], [true, false]);
  restore();
  redis.pipeline = (async () => {
    throw new Error("Redis request failed with status 503");
  }) as typeof redis.pipeline;
  html = await page();
  is("Redis down: the page says so", html.includes(unloaded), true);
  is("Redis down: never 'No notice has been counted yet'", html.includes("No notice has been counted yet"), false);
  restore();
  html = await page();
  is("read as kept, the page shows the counts", [html.includes(unloaded), html.includes("Counted from January 15, 2026")], [false, true]);
  redis.clear();
  is("nothing counted, the page says so", (await page()).includes("No notice has been counted yet"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
