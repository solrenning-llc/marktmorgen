/**
 * The public transparency page (app/transparency/page.tsx, lib/transparency.ts)
 * never says "No notice has been counted yet" or a zero it did not read
 * (rule 24; nothing false shown to a person). A start day that is truly not
 * there is still the honest "counting begins with the first notice"; a year
 * with no counts yet is still zeros. A reply in an unknown shape, or a read
 * that fails, is said as not read just now.
 */
import { renderToStaticMarkup } from "react-dom/server";
import TransparencyPage from "@/app/transparency/page";
import { countNotice, countStep, transparencyCounts } from "@/lib/transparency";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const NOV = Date.UTC(2026, 10, 3);
const NONE = "No notice has been counted yet";
const UNREAD = "could not be read just now";

async function page(): Promise<string> {
  return renderToStaticMarkup(await TransparencyPage());
}

/** Runs `work` with every pipeline whose first command is `command` answered by `answer`. */
async function answering<T>(command: string, answer: (commands: Commands) => unknown[], work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === command ? answer(commands) : original.call(redis, commands))) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function throws(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "returned";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown reply" : "other error";
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Confirmed absence stays honest");
  is("no start day: nothing counted yet", await transparencyCounts(NOV), { since: null, years: [] });
  is("the page says counting begins with the first notice", (await page()).includes(NONE), true);

  part("Healthy control");
  await countNotice("copyright", NOV);
  await countStep({ id: "a".repeat(16), kind: "copyright" }, "product", NOV);
  const counts = await transparencyCounts(NOV);
  is("the start day", counts.since, "2026-11-03");
  is("the counts", [counts.years[0].notices, counts.years[0].acted, counts.years[0].steps], [{ copyright: 1, other: 0 }, { copyright: 1, other: 0 }, { link: 0, product: 1, kit: 0, store: 0 }]);
  is("a year with nothing in it yet is zeros (its hash is not there)", (await transparencyCounts(Date.UTC(2027, 1, 1))).years[0].notices, { copyright: 0, other: 0 });

  part("An unknown start-day reply is never 'nothing counted'");
  for (const [name, reply] of [["a number", 5], ["an object", {}], ["not a day", "soon"], ["no reply at all", undefined]] as const) {
    const got = await answering("GET", () => (reply === undefined ? [] : [reply]), () => throws(() => transparencyCounts(NOV)));
    is(`${name}: refused as unknown`, got, "unknown reply");
  }

  part("An unknown year reply is never a zero");
  for (const [name, reply] of [
    ["not a list", "x"],
    ["a count that is not a number", ["notice:copyright", "abc"]],
    ["a list of odd length", ["notice:copyright"]],
    ["a member that is not text", ["notice:copyright", 3]],
  ] as const) {
    const got = await answering("HGETALL", (commands) => commands.map((_, i) => (i === 0 ? reply : [])), () => throws(() => transparencyCounts(NOV)));
    is(`${name}: refused as unknown`, got, "unknown reply");
  }
  is("one reply missing for the years asked: refused", await answering("HGETALL", () => [], () => throws(() => transparencyCounts(NOV))), "unknown reply");

  part("The page says it could not read, never that nothing was counted");
  const failed = await answering("GET", () => { throw new Error("connection reset"); }, page);
  is("a failed read: not 'nothing counted'", failed.includes(NONE), false);
  is("a failed read: said as not read just now", failed.includes(UNREAD), true);
  const odd = await answering("GET", () => [7], page);
  is("an unknown reply: not 'nothing counted'", odd.includes(NONE), false);
  is("an unknown reply: said as not read just now", odd.includes(UNREAD), true);
  const zero = await answering("HGETALL", (commands) => commands.map(() => "x"), page);
  is("an unknown year: no table of zeros", zero.includes("<td>0</td>"), false);
  is("an unknown year: said as not read just now", zero.includes(UNREAD), true);
  const healthy = await page();
  is("healthy: the table is shown", [healthy.includes("<td>1</td>"), healthy.includes(UNREAD)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
