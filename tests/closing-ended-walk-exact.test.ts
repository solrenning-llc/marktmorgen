/**
 * The daily walk of stores whose plan ended reads its cursor and its pages
 * exactly (CX-123 rules 24 and 30; the same pattern as Claude 5's focal review
 * of #3279, in lib/plan-closing.ts closeEnded).
 *
 * closeEnded read the ended line's cursor (GET) as "0" whenever it was not a
 * text of digits, and a page of the line (ZRANGEBYSCORE ... WITHSCORES) as an
 * empty page whenever it was not a list. An unknown page ended the walk there:
 * its cursor was deleted, and the stores on that page and after were not
 * looked at that day (no notice, no hold, no closing day begun) while the run
 * answered as if it had walked the whole line. An unknown cursor started the
 * walk over and deleted the saved one.
 *
 * Now: Redis's null is no cursor; any other shape throws UnknownReplyError
 * before a store on that page is looked at, and the cursor stays where it was
 * (the cron answers 500, the next run reads it again). Synthetic data only.
 */
import { closeEnded } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const AFTER = "nl:plan:closing:after";
const PAGE = 200;
type Commands = (string | number)[][];
const pipe = redis.pipeline.bind(redis);
const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
/** The pipeline as it is, but the first command `pick` names answers `reply` (once, so a walk that took it for a full page cannot go round forever). */
const answers = (pick: (command: (string | number)[]) => boolean, reply: unknown) => {
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (!used && pick(commands[i]) ? ((used = true), reply) : r));
  }) as typeof redis.pipeline;
};
const isCursor = (command: (string | number)[]) => command[0] === "GET" && command[1] === AFTER;
const isPage = (command: (string | number)[]) => command[0] === "ZRANGEBYSCORE" && command[1] === ENDED_INDEX;
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const raw = async (key: string) => (await pipe([["GET", key]]))[0];
const inLine = async (ref: string) => (await pipe([["ZSCORE", ENDED_INDEX, ref]]))[0] !== null;

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const now = Date.now();
  const deadline = () => Date.now() + 20_000;
  // A ref with no store behind it: the daily look takes it out of the line ("gone"), so a look is seen.
  const ref = "ended-walk-gone@example.test";
  const reset = async (cursor: string | null) => {
    await pipe([["DEL", AFTER], ["ZADD", ENDED_INDEX, now - DAY, ref]]);
    if (cursor !== null) await pipe([["SET", AFTER, cursor]]);
  };
  const looked = (rows: unknown) => (rows as { key: string; state: string }[]).filter((row) => row.key === ref).map((row) => row.state);

  part("controls: no cursor, a cursor as it is saved, and an empty line");
  await reset(null);
  const fresh = await closeEnded(deadline(), now);
  is("no cursor (Redis's null): the store is looked at, and no cursor is left", [looked(fresh), await inLine(ref), await raw(AFTER)], [["gone"], false, null]);
  await reset("1");
  const saved = await closeEnded(deadline(), now);
  is("a saved cursor: the store past it is looked at, and the cursor is done with", [looked(saved), await raw(AFTER)], [["gone"], null]);
  await pipe([["ZREM", ENDED_INDEX, ref], ["SET", AFTER, "1"]]);
  const empty = await closeEnded(deadline(), now);
  is("an empty line (Redis's empty list): nothing looked at, the walk done", [looked(empty), await raw(AFTER)], [[], null]);

  const UNKNOWN_CURSORS: [string, unknown][] = [
    ["a missing reply (undefined)", undefined],
    ["a number, not its text", 7],
    ["an empty text", ""],
    ["a text that is not digits", "soon"],
    ["a list", ["1"]],
    ["an object", { after: "1" }],
  ];
  for (const [name, reply] of UNKNOWN_CURSORS) {
    part(`the ended line's cursor is ${name}`);
    await reset("1");
    answers(isCursor, reply);
    const r = await settled(closeEnded(deadline(), now));
    restore();
    is("refused as unknown, never a walk started over", r, { ok: false, error: "UnknownReplyError" });
    is("the cursor stays where it was, and no store is looked at on it", [await raw(AFTER), await inLine(ref)], ["1", true]);
  }

  const UNKNOWN_PAGES: [string, unknown][] = [
    ["a missing reply (undefined)", undefined],
    ["a text", "garbled"],
    ["an object", { 0: ref, 1: String(now - DAY) }],
    ["a member with no score", [ref]],
    ["a member that is not a text", [7, String(now - DAY)]],
    ["a score that is not a number", [ref, "soon"]],
    ["a score that is an object", [ref, { score: now - DAY }]],
    ["more than a page", Array.from({ length: PAGE + 1 }, (_, i) => [`ended-${i}@example.test`, String(now - DAY)]).flat()],
  ];
  for (const [name, reply] of UNKNOWN_PAGES) {
    part(`a page of the ended line is ${name}`);
    await reset("1");
    answers(isPage, reply);
    const r = await settled(closeEnded(deadline(), now));
    restore();
    is("refused as unknown, never an empty page that ends the walk", r, { ok: false, error: "UnknownReplyError" });
    is("the cursor stays where it was, and the store on it is still in line", [await raw(AFTER), await inLine(ref)], ["1", true]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
