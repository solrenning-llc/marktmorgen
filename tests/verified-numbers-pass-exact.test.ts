/**
 * The daily pass of the shared numbers (lib/verified-numbers.ts, sendVerified
 * and refreshVerified) reads Redis only in its exact shape (CX-123 rule 24).
 *
 *   - Where the last pass stopped (nl:verified:cursor) is a string, or null
 *     when no pass has run yet. Any other reply (no reply, two replies, a
 *     number, an object, a list) is unknown: the pass refuses before it reads
 *     any store or writes anything, so the position kept by the last pass is
 *     never overwritten by one counted from the start, and stores already
 *     read today are not read again from their creators' Stripe accounts.
 *   - A record kept counts as kept only when Redis answered "OK" to its SET;
 *     another reply throws, so the daily report never counts a store whose
 *     record may not be there.
 *   - Healthy controls: no position yet starts from the beginning and reads
 *     the store; a kept position goes on from it; both write the position at
 *     the end exactly as before.
 *
 * Synthetic store and Redis only; Stripe answers an empty list and no real
 * provider is called.
 */
import { refreshVerified, sendVerified } from "@/lib/verified-numbers";
import { makeLink } from "@/lib/numbers-links";
import { addNumbersLink, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
const quiet = console.error;

const CURSOR = "nl:verified:cursor";
const pipeline = redis.pipeline.bind(redis);
let cursorReply: { value: unknown } | null = null;
let keptReply: { value: unknown } | null = null;
let recordKey = "";
const writes: string[] = [];
redis.pipeline = async (commands) => {
  const [command, key] = [String(commands[0]?.[0] ?? ""), String(commands[0]?.[1] ?? "")];
  if (command === "GET" && key === CURSOR && cursorReply) return cursorReply.value as unknown[];
  if (command === "SET" && (key === CURSOR || key === recordKey)) {
    writes.push(key === CURSOR ? `cursor=${String(commands[0][2])}` : "record");
    if (key === recordKey && keptReply) return keptReply.value as unknown[];
  }
  return pipeline(commands);
};

async function outcome(run: () => Promise<unknown>): Promise<string> {
  console.error = () => {};
  try {
    return `ok ${JSON.stringify(await run())}`;
  } catch (error) {
    return `threw ${(error as Error).name}`;
  } finally {
    console.error = quiet;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  const made = makeLink({ label: "Partner", password: "harbor-2026", days: 7, money: false }, now);
  if (!made.ok) throw new Error("no link");
  await addNumbersLink("owner@example.com", made.link, now);
  const store = (await storeForEmail("owner@example.com"))!;
  recordKey = `nl:verified:${store.statsId}`;
  const deadline = () => Date.now() + 60_000;

  part("Healthy controls: no position yet, and a kept position");
  writes.length = 0;
  is("no position yet: the store is read and the pass ends at the start", [await outcome(() => sendVerified(deadline())), writes], ['ok {"stores":1}', ["record", "cursor=0|0"]]);
  await pipeline([["SET", CURSOR, "0|1"]]);
  writes.length = 0;
  is("a kept position: the store already read is skipped", [await outcome(() => sendVerified(deadline())), writes], ['ok {"stores":0}', ["cursor=0|0"]]);

  part("Where the last pass stopped, read in an unknown shape, stops the pass");
  for (const [label, value] of [
    ["no reply", []],
    ["two replies for one command", ["0|1", "0|1"]],
    ["a missing result", [undefined]],
    ["a number", [7]],
    ["an object", [{ cursor: "0", done: 1 }]],
    ["a list", [["0|1"]]],
    ["a boolean", [true]],
  ] as [string, unknown[]][]) {
    await pipeline([["SET", CURSOR, "0|1"]]);
    cursorReply = { value };
    writes.length = 0;
    const said = await outcome(() => sendVerified(deadline()));
    cursorReply = null;
    const [kept] = await pipeline([["GET", CURSOR]]);
    is(`${label}: refused, no store read again, the kept position untouched`, [said, writes, kept], ["threw UnknownReplyError", [], "0|1"]);
  }

  part("A record counts as kept only when its SET answered OK");
  keptReply = { value: ["OK"] };
  is("OK: the record is returned", (await outcome(() => refreshVerified(store))).startsWith("ok {"), true);
  for (const [label, value] of [
    ["no reply", []],
    ["a missing result", [undefined]],
    ["null (not set)", [null]],
    ["a number", [0]],
    ["another word", ["QUEUED"]],
  ] as [string, unknown[]][]) {
    keptReply = { value };
    is(`${label}: not said as kept`, await outcome(() => refreshVerified(store)), "threw UnknownReplyError");
    await pipeline([["DEL", CURSOR]]);
    is(`${label}: the daily report does not count the store`, await outcome(() => sendVerified(deadline())), 'ok {"stores":0}');
  }
  keptReply = null;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
