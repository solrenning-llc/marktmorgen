/**
 * CX-123 rule 24, lib/contacts.ts upsertContact: before it writes an address,
 * it reads the address's row (HGET), the list's size (HLEN) and whether the
 * address was deleted from the store (HEXISTS on its fingerprint). HGET
 * answers text or nothing; HLEN and HEXISTS answer a count. A reply in any
 * other shape, or a pipeline that answers fewer replies than it was sent, is
 * unknown: it is never read as "nobody on the list by that address", "room on
 * the list" or "never deleted". Read that way, a person who unsubscribed was
 * written back as a new contact who agreed (an old yes repeated by a reloaded
 * thank-you page), losing their unsubscribe, why they were taken off and the
 * token of the link in emails already sent; a full list took one more; and a
 * deleted person was put back as agreeing on a yes that was not their own.
 * Unknown throws, and nothing is written. Synthetic list; one reply injected
 * per case.
 */
import { store as redis } from "./redis-stub";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: ((batch: Command[], values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  // Only upsertContact's first read (HGET, HLEN, the fingerprint's HEXISTS) is changed.
  if (inject && batch.length === 3 && batch[0][0] === "HGET" && batch[1][0] === "HLEN" && batch[2][0] === "HEXISTS") return inject(batch, values);
  return values;
}) as typeof redis.pipeline;

const LIST = "a1b2c3d4e5f6";
const LEFT = "left.reader@example.com";
const NEW = "new.reader@example.com";
const ERASED = "erased.reader@example.com";
const TOKEN = "ab".repeat(20);
const ORDER_AT = "2026-11-01T10:00:00.000Z";
const LEFT_AT = "2026-11-03T10:00:00.000Z";
const leftRow = JSON.stringify({
  agreed: true, agreedAt: ORDER_AT, firstAt: ORDER_AT, lastAt: LEFT_AT, titles: ["Guide"], ids: ["prod_guide"], source: "buyer",
  unsub: true, unsubAt: LEFT_AT, gone: "complained", t: TOKEN, name: "Left Reader", tags: ["vip"], importedAt: "",
});

function reset(): void {
  redis.clear();
  redis.run(["HSET", leadsKey(LIST), LEFT, leftRow]);
  redis.run(["HSET", suppressedKey(LIST), suppressionPrint(LIST, ERASED), "1"]);
}
const row = (email: string) => redis.run(["HGET", leadsKey(LIST), email]);

async function attempt(email: string, input: Parameters<typeof upsertContact>[2]): Promise<"threw" | "written"> {
  try {
    await upsertContact(LIST, email, input, null);
    return "written";
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  // The same old yes again: the thank-you page of an order placed before they unsubscribed, reloaded.
  const reload = { agreed: true, explicit: true, source: "buyer" as const, at: ORDER_AT };

  part("Control: the replies as Redis gives them");
  reset();
  is("a reloaded old yes leaves someone who unsubscribed since as they are", [await attempt(LEFT, reload), row(LEFT)], ["written", JSON.stringify({ ...JSON.parse(leftRow), lastAt: JSON.parse(row(LEFT) as string).lastAt })]);
  is("still unsubscribed, still taken off for a complaint, still with their link's token", (() => { const c = JSON.parse(row(LEFT) as string); return [c.unsub, c.gone, c.t]; })(), [true, "complained", TOKEN]);
  reset();
  is("someone deleted from the store is not put back as agreeing on a yes that is not their own", [await attempt(ERASED, { agreed: true, explicit: false, source: "import" }), JSON.parse(row(ERASED) as string).agreed], ["written", false]);

  const rowReplies: [string, unknown][] = [
    ["a number", 7],
    ["a list", [leftRow]],
    ["an object", { value: leftRow }],
    ["true", true],
    ["no reply at all", undefined],
  ];
  for (const [what, value] of rowReplies) {
    part(`The row of someone who unsubscribed, answered as ${what}`);
    reset();
    inject = (_batch, values) => [value, values[1], values[2]];
    const outcome = await attempt(LEFT, reload);
    inject = null;
    is(`${what}: unknown, never "not on the list" (nothing written)`, outcome, "threw");
    is(`${what}: the row is exactly as it was: still unsubscribed, the complaint and the token kept`, row(LEFT), leftRow);
  }

  part("The pipeline answers fewer replies than it was sent");
  reset();
  inject = (_batch, values) => values.slice(0, 2);
  is("two replies for three commands: unknown, never \"never deleted\"", await attempt(ERASED, { agreed: true, explicit: false, source: "import" }), "threw");
  inject = null;
  is("the deleted person was not put back", row(ERASED), null);
  reset();
  inject = (_batch, values) => values.slice(0, 1);
  is("one reply for three commands: unknown", await attempt(NEW, reload), "threw");
  inject = null;
  is("nobody was written", row(NEW), null);

  const sizeReplies: [string, unknown][] = [
    ["nothing", null],
    ["text", "x"],
    ["a negative count", -1],
    ["a fraction", 1.5],
    ["a list", [3]],
  ];
  for (const [what, value] of sizeReplies) {
    part(`The list's size answered as ${what}`);
    reset();
    inject = (_batch, values) => [values[0], value, values[2]];
    const outcome = await attempt(NEW, reload);
    inject = null;
    is(`${what}: unknown, never room on the list`, [outcome, row(NEW)], ["threw", null]);
  }

  const erasedReplies: [string, unknown][] = [
    ["nothing", null],
    ["text", "1"],
    ["two", 2],
    ["a list", [1]],
    ["true", true],
  ];
  for (const [what, value] of erasedReplies) {
    part(`Whether the address was deleted, answered as ${what}`);
    reset();
    inject = (_batch, values) => [values[0], values[1], value];
    const outcome = await attempt(ERASED, { agreed: true, explicit: false, source: "import" });
    inject = null;
    is(`${what}: unknown, never "never deleted" (nothing written)`, [outcome, row(ERASED)], ["threw", null]);
  }

  part("A new address with every reply in shape is still written");
  reset();
  is("a sign-up with the box checked joins", [await attempt(NEW, reload), JSON.parse(row(NEW) as string).agreed], ["written", true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
