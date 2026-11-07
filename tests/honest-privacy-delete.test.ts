/**
 * "Delete your data" opened from a store's own link (app/privacy/delete/page.tsx,
 * ?store=<handle>) never quietly drops the choice of that store alone because
 * the store could not be read just now (nothing false shown to a person).
 * Before, the page then asked for every store without a word and told the
 * person to use the link at the foot of that store's page, which is the link
 * they had just used. A store that truly is not there still gets the page
 * for every store, as before.
 */
import { renderToStaticMarkup } from "react-dom/server";
import DeletePage from "@/app/privacy/delete/page";
import { claimHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const UNREAD = "We could not load that store just now";
const FOOT = "use the link at the foot of that store";
const ALL = 'name="scope" value="all"';

async function page(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await DeletePage({ searchParams: Promise.resolve(query) }));
}

async function failing<T>(work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some((command) => String(command[1] ?? "").startsWith("nl:store:handle:"))) throw new Error("connection reset");
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Runs `work` with the pipeline that GETs a key starting with `prefix` answered by `reply`. */
async function answering<T>(prefix: string, reply: unknown[], work: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) =>
    commands.some((command) => command[0] === "GET" && String(command[1] ?? "").startsWith(prefix)) ? [...reply] : original.call(redis, commands)) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  if (!(await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "")).ok) throw new Error("no store");

  part("Healthy control");
  const healthy = await page({ store: "harbor" });
  is("that store alone is offered, and nothing is said to be unread", [healthy.includes("Harbor Kitchen only"), healthy.includes(UNREAD)], [true, false]);

  part("Confirmed absence stays as it was");
  const unknown = await page({ store: "nosuchstore" });
  is("a store that is not there: the page for every store, and nothing said to be unread", [unknown.includes(ALL), unknown.includes(FOOT), unknown.includes(UNREAD)], [true, true, false]);
  const plain = await page({});
  is("no store asked: the page for every store", [plain.includes(ALL), plain.includes(UNREAD)], [true, false]);

  part("A store that could not be read is said so");
  const failed = await failing(() => page({ store: "harbor" }));
  is("said as not read just now", failed.includes(UNREAD), true);
  is("never told to use the link they just used", failed.includes(FOOT), false);
  is("a link tries the same store again", failed.includes('href="/privacy/delete?store=harbor"'), true);

  part("A store answered in an unknown shape is said so too, never 'no such store' (review of #2970, MEDIUM)");
  for (const [name, prefix, reply] of [
    ["the handle: no reply", "nl:store:handle:", []],
    ["the handle: a hole where the reply should be", "nl:store:handle:", [undefined]],
    ["the handle: a number", "nl:store:handle:", [42]],
    ["the handle: a list", "nl:store:handle:", [["owner@example.com"]]],
    ["the store's record: no reply", "nl:store:owner:", []],
    ["the store's record: a number", "nl:store:owner:", [7]],
    ["the store's record: not a store", "nl:store:owner:", ["{not json"]],
  ] as const) {
    const html = await answering(prefix, [...reply], () => page({ store: "harbor" }));
    is(`${name}: [said as not read just now, told to use the foot link, that store alone offered]`, [html.includes(UNREAD), html.includes(FOOT), html.includes("Harbor Kitchen only")], [true, false, false]);
  }
  const back = await page({ store: "harbor" });
  is("control: read again, that store alone is offered", [back.includes("Harbor Kitchen only"), back.includes(UNREAD)], [true, false]);
  const released = await answering("nl:store:handle:", ["released:1"], () => page({ store: "harbor" }));
  is("control: a handle that was let go is a store not there, as before", [released.includes(ALL), released.includes(FOOT), released.includes(UNREAD)], [true, true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
