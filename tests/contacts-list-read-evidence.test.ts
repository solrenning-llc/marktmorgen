/**
 * CX-123 rule 24, lib/contacts.ts, the two other reads beside upsertContact's
 * (tests/contacts-upsert-read-evidence.test.ts):
 *
 *   - stopWriting reads the address's row (HGET: text or nothing) before it
 *     takes off an address that bounced for good or whose owner marked an
 *     email as spam. A reply in another shape was read as "not on the list":
 *     the sender's notice was dropped and the address kept being written to.
 *     Now it throws, so the notice is not acted on and is heard again.
 *   - forEachContact walks the list by HSCAN pages ([cursor, [field, value,
 *     ...]]). A page in another shape ended the walk as if the list ended, so
 *     an email (audience) went to part of the list as if to all of it. Now it
 *     throws, and so does a walk that never reaches the cursor "0".
 *
 * Synthetic list; one reply injected per case.
 */
import { store as redis } from "./redis-stub";
import { audience, leadsKey, stopWriting } from "@/lib/contacts";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: ((batch: Command[], values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return inject ? inject(batch, values) : values;
}) as typeof redis.pipeline;

const LIST = "f0e1d2c3b4a5";
const A = "reader.one@example.com";
const B = "reader.two@example.com";
const contact = (t: string) => JSON.stringify({ agreed: true, agreedAt: "2026-11-01T00:00:00.000Z", firstAt: "2026-11-01T00:00:00.000Z", lastAt: "2026-11-01T00:00:00.000Z", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t, name: "", tags: [], importedAt: "" });

function reset(): void {
  redis.clear();
  redis.run(["HSET", leadsKey(LIST), A, contact("ab".repeat(20)), B, contact("cd".repeat(20))]);
}
const unsub = (email: string) => JSON.parse(redis.run(["HGET", leadsKey(LIST), email]) as string).unsub;
async function outcome<T>(run: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}
const onlyHget = (value: unknown) => (batch: Command[], values: unknown[]) => (batch.length === 1 && batch[0][0] === "HGET" ? value : values) as unknown[];
const onlyHscan = (value: (values: unknown[]) => unknown) => (batch: Command[], values: unknown[]) => (batch[0][0] === "HSCAN" ? value(values) : values) as unknown[];

async function main(): Promise<void> {
  part("Control: replies as Redis gives them");
  reset();
  is("a complaint takes the address off and says it could be written to until now", [await stopWriting(LIST, A, "complained"), unsub(A)], [true, true]);
  reset();
  is("an email goes to everyone on the list", (await audience(LIST)).sort(), [A, B]);

  const rows: [string, unknown][] = [
    ["a number", [7]],
    ["a list", [[contact("ab".repeat(20))]]],
    ["an object", [{ value: 1 }]],
    ["true", [true]],
    ["no reply at all", []],
    ["two replies for one command", [null, null]],
  ];
  for (const [what, reply] of rows) {
    part(`stopWriting: the row answered as ${what}`);
    reset();
    inject = onlyHget(reply);
    const told = await outcome(() => stopWriting(LIST, A, "complained"));
    inject = null;
    is(`${what}: unknown, never "not on the list" (the notice is heard again)`, told, "threw");
  }

  const pages: [string, (values: unknown[]) => unknown][] = [
    ["no page", () => [null]],
    ["an empty reply", () => []],
    ["a cursor alone", () => [["0"]]],
    ["a cursor that is not one", () => [[{}, []]]],
    ["the fields not a list", (values) => [[(values[0] as unknown[])[0], "nope"]]],
    ["a field without its value", (values) => [[(values[0] as unknown[])[0], ((values[0] as unknown[])[1] as unknown[]).slice(0, 3)]]],
    ["a field that is not text", (values) => [[(values[0] as unknown[])[0], [7, ...((values[0] as unknown[])[1] as unknown[]).slice(1)]]]],
    ["a page that never ends", (values) => [["5", (values[0] as unknown[])[1]]]],
  ];
  for (const [what, page] of pages) {
    part(`audience: an HSCAN page answered as ${what}`);
    reset();
    inject = onlyHscan(page);
    const to = await outcome(() => audience(LIST));
    inject = null;
    is(`${what}: unknown, never the end of the list`, to, "threw");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
