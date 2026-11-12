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

/** The page as rendered on the day `now` (the page reads the clock itself). */
async function page(now = NOV): Promise<string> {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return renderToStaticMarkup(await TransparencyPage());
  } finally {
    Date.now = realNow;
  }
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
  part("A start day that is no real day, or out of range, is unknown (review 5807744601, Claude 5 LEVE 1)");
  for (const [name, day] of [
    ["an impossible day", "2026-99-99"],
    ["a day that does not exist", "2026-02-30"],
    ["a day after today", "2026-11-04"],
    ["a far-future day", "9999-01-01"],
    ["a day before counting could have begun", "1000-01-01"],
  ] as const) {
    const sent: number[] = [];
    const got = await answering("GET", () => [day], async () => {
      const original: Pipeline = redis.pipeline;
      redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "HGETALL" && sent.push(commands.length), original.call(redis, commands))) as Pipeline;
      try {
        return await throws(() => transparencyCounts(NOV));
      } finally {
        redis.pipeline = original;
      }
    });
    is(`${name}: refused as unknown`, got, "unknown reply");
    is(`${name}: no year read from it`, sent.length, 0);
    is(`${name}: the page says not read, and does not crash`, await answering("GET", () => [day], async () => {
      try {
        return (await page()).includes(UNREAD) ? "unread" : "no unread message";
      } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : "other error";
      }
    }), "unread");
  }
  is("control: today is a valid start day", (await answering("GET", () => ["2026-11-03"], () => transparencyCounts(NOV))).since, "2026-11-03");
  is("control: the first day of 2026 is a valid start day", (await answering("GET", () => ["2026-01-01"], () => transparencyCounts(NOV))).since, "2026-01-01");

  part("A year's counts with a field we never write, or a field twice, are unknown");
  for (const [name, reply] of [
    ["a field we never write", ["notice:copyrigh", "4"]],
    ["the same field twice", ["notice:copyright", "1", "notice:copyright", "2"]],
  ] as const) {
    const got = await answering("HGETALL", (commands) => commands.map((_, i) => (i === 0 ? reply : [])), () => throws(() => transparencyCounts(NOV)));
    is(`${name}: refused as unknown`, got, "unknown reply");
  }
  is("control: every field we write is read", (await answering("HGETALL", (commands) => commands.map(() => ["notice:other", "2", "acted:other", "1", "step:store", "1"]), () => transparencyCounts(NOV))).years[0].notices.other, 2);

  part("A year whose counts may have expired is never shown as zeros (Claude 5 LEVE 2)");
  const later = Date.UTC(2033, 1, 1);
  const old = await transparencyCounts(later);
  is("the start day is still said", old.since, "2026-11-03");
  is("years whose counts may have expired are not listed", old.years.map((y) => y.year).includes("2026"), false);
  is("years still kept are listed", old.years[0].year, "2033");
  const oldPage = await page(later);
  is("the page has no 2026 table", oldPage.includes('id="year-2026"'), false);
  is("the page says older years are no longer kept", oldPage.includes("are no longer kept"), true);
  is("control: today, 2026 is listed and nothing is said to be gone", [(await page()).includes('id="year-2026"'), (await page()).includes("are no longer kept")], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
