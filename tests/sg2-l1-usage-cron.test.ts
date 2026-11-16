/**
 * The daily usage watch (app/api/cron/usage/route.ts) does every part it can
 * when one part cannot be read (audit SG2, CX-123 rule 24).
 *
 * storesOverAllowance (lib/delivery.ts) throws when the month's list of
 * stores past the delivery allowance, or a total, comes back unknown. The
 * watch's other parts (video hours, visits, orders) are each run whatever
 * that part does; the delivery part is caught on its own, said as "unknown"
 * in the log and in the run's answer (`unread`), its told list left as it was, and the
 * run answers an error only at the end, with every other part's result in
 * it. A run whose every part was read answers as before.
 */
import { GET } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let deliveryList: unknown = undefined;
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  const list = commands[0]?.[0] === "SMEMBERS" && String(commands[0]?.[1]).startsWith("nl:store:delivery:over:");
  if (list && deliveryList === "throw") throw new Error("the database did not answer");
  if (list && deliveryList !== undefined) return deliveryList as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

const request = { headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof GET>[0];
const askedFor = (from: number, pattern: RegExp) =>
  sent.slice(from).some((commands) => commands.some((c) => c[0] === "SMEMBERS" && pattern.test(String(c[1]))));
const toldWritten = (from: number) => sent.slice(from).some((commands) => commands.some((c) => c[0] === "SET" && c[1] === "nl:usage-watch:told"));

async function run(): Promise<{ status: number; body: Record<string, unknown>; from: number }> {
  const from = sent.length;
  try {
    const response = await GET(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, from };
  } catch {
    return { status: -1, body: {}, from };
  }
}

async function main(): Promise<void> {
  redis.clear();
  delete process.env.CRON_SECRET;

  for (const [label, reply] of [
    ["the list cannot be asked", "throw"],
    ["the list answered null", [null]],
    ["the list holding a number", [["a", 1]]],
  ] as [string, unknown][]) {
    part(`delivery allowance: ${label}`);
    deliveryList = reply;
    const got = await run();
    is("the run answers an error at the end, never throws", got.status >= 500, true);
    is("and names the part that is unknown", got.body.unread, ["delivery"]);
    is("video hours still ran, and are in the answer", [askedFor(got.from, /watch/), typeof got.body.video], [true, "object"]);
    is("visits still ran, and are in the answer", [askedFor(got.from, /traffic|visit/), typeof got.body.visits], [true, "object"]);
    is("orders still ran, and are in the answer", [askedFor(got.from, /order/), typeof got.body.orders], [true, "object"]);
    is("the delivery told list is left as it was", toldWritten(got.from), false);
  }

  part("every part read: as before");
  deliveryList = undefined;
  const fine = await run();
  is("ok", [fine.status, fine.body.ok, fine.body.over], [200, true, 0]);
  is("nothing named unknown", fine.body.unread ?? [], []);

  done();
}

void main();
