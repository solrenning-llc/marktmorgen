/**
 * The daily usage run (app/api/cron/usage/route.ts) reads three lists of
 * stores before it writes to anyone: the stores whose video was watched
 * (lib/watch.ts watchedFolders), the stores that were visited
 * (lib/traffic.ts visitedFolders) and the stores with orders
 * (lib/orders.ts orderedFolders). A reply that is not one list of strings is
 * unknown (CX-123 rule 24), never "no store":
 *
 *   - visitedFolders and orderedFolders throw UnknownReplyError on it, as
 *     watchedFolders does;
 *   - the run says the part as unread at the end ("visits", "orders"),
 *     answers 503, never "ok", and logs it;
 *   - every other part still runs, each list asked once.
 */
import { GET as usageJob } from "@/app/api/cron/usage/route";
import { visitedFolders } from "@/lib/traffic";
import { orderedFolders } from "@/lib/orders";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "stub-token";
delete process.env.CRON_SECRET;

type Command = (string | number)[];

const WATCHED = /^nl:watch:folders:/;
const VISITED = /^nl:traffic:folders:/;
const ORDERED = /^nl:orders:folders:/;
const DELIVERY = /^nl:store:delivery:over:/;

/** What each list is answered with this run: an unknown shape, or a database that does not answer. */
let inject: { key: RegExp; reply: unknown[] | "throw" }[] = [];
const sent: Command[][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  sent.push(commands);
  const first = commands[0];
  const hit = commands.length === 1 && first?.[0] === "SMEMBERS" ? inject.find((i) => i.key.test(String(first[1]))) : undefined;
  if (hit) {
    if (hit.reply === "throw") throw new Error("the database did not answer");
    return hit.reply;
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const errors: unknown[][] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args);
};

/** How many times this run asked for one list. */
const asked = (from: number, key: RegExp) =>
  sent
    .slice(from)
    .flat()
    .filter((c) => c[0] === "SMEMBERS" && key.test(String(c[1]))).length;

function request(path: string) {
  return { headers: new Headers(), nextUrl: new URL(`https://marktmorgen.com${path}`) } as unknown as Parameters<typeof usageJob>[0];
}

async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number; logged: number }> {
  const from = sent.length;
  const before = errors.length;
  try {
    const response = await usageJob(request("/api/cron/usage"));
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, from, logged: errors.length - before };
  } catch {
    return { status: -1, body: {}, from, logged: errors.length - before };
  }
}

async function thrown(read: () => Promise<unknown>): Promise<string> {
  try {
    await read();
    return "read";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "other";
  }
}

async function main(): Promise<void> {
  redis.clear();
  const month = new Date().toISOString().slice(0, 7);

  part("the lists themselves: an unknown shape throws, never an empty list");
  const shapes: [string, unknown[]][] = [
    ["a text where the list goes", ["OK"]],
    ["a list holding a number", [[7]]],
    ["an object where the list goes", [{}]],
    ["no reply at all", []],
    ["two replies for one command", [[], []]],
  ];
  for (const [label, reply] of shapes) {
    inject = [{ key: VISITED, reply }, { key: ORDERED, reply }];
    is(`visited stores, ${label}: unknown`, await thrown(() => visitedFolders(month)), "unknown");
    is(`ordered stores, ${label}: unknown`, await thrown(() => orderedFolders(month)), "unknown");
  }
  inject = [];
  // A folder is 32 hex characters (lib/traffic.ts, lib/orders.ts); anything else in the set is left out, as before.
  const [a, b, c] = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccc"];
  await pipeline([
    ["SADD", `nl:traffic:folders:${month}`, b, a, "not-a-folder"],
    ["SADD", `nl:orders:folders:${month}`, c],
  ]);
  is("a list read whole is the stores, sorted, as before", [await visitedFolders(month), await orderedFolders(month)], [[a, b], [c]]);
  redis.clear();

  const cases: [string, typeof inject, string[]][] = [
    ["the visited stores answered in an unknown shape", [{ key: VISITED, reply: ["OK"] }], ["visits"]],
    ["the visited stores could not be asked", [{ key: VISITED, reply: "throw" }], ["visits"]],
    ["the ordered stores answered in an unknown shape", [{ key: ORDERED, reply: [[7]] }], ["orders"]],
    ["the ordered stores could not be asked", [{ key: ORDERED, reply: "throw" }], ["orders"]],
    ["visited and ordered stores both unknown", [{ key: VISITED, reply: [{}] }, { key: ORDERED, reply: ["OK"] }], ["visits", "orders"]],
    ["all three lists unknown", [{ key: WATCHED, reply: ["OK"] }, { key: VISITED, reply: ["OK"] }, { key: ORDERED, reply: ["OK"] }], ["video", "visits", "orders"]],
  ];
  for (const [label, injected, unread] of cases) {
    part(`usage run: ${label}`);
    inject = injected;
    const got = await run();
    inject = [];
    is("the run answers 503 at the end, never ok, never throws", [got.status, got.body.ok], [503, false]);
    is("and names each unread part", got.body.unread, unread);
    is("and the failure is logged", got.logged > 0, true);
    is("video, visits and orders are each in the answer", [typeof got.body.video, typeof got.body.visits, typeof got.body.orders], ["object", "object", "object"]);
    is("the watched stores asked", asked(got.from, WATCHED) > 0, true);
    is("the visited stores asked, whatever the video part did", asked(got.from, VISITED) > 0, true);
    is("the ordered stores asked, whatever the visits part did", asked(got.from, ORDERED) > 0, true);
    is("the delivery part still ran", asked(got.from, DELIVERY) > 0, true);
  }

  part("usage run: every list read: as before");
  const fine = await run();
  is("ok", [fine.status, fine.body.ok], [200, true]);
  is("nothing named unread", fine.body.unread ?? [], []);

  console.error = consoleError;
  done();
}

void main();
