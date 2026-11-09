/**
 * A program's public numbers (lib/affiliates.ts, programNumbers) are read
 * from four HGETALL replies. A reply that is missing, cut short or of another
 * shape (a hole, an odd count, a member that is not a string, a Proxy, a
 * pipeline answering fewer replies than were sent) is never read as no
 * affiliates, no clicks, no sales or nothing paid: programNumbers throws
 * UnknownReplyError (lib/redis-reply.ts), and the public affiliate directory
 * (lib/affiliate-directory.ts, readDirectory) shows that program's row
 * without numbers, never with zeros, here and in any page it keeps.
 *
 * A click count is written only by HINCRBY, so a value that is not a whole
 * number from zero up is of an unknown shape too, never a zero.
 *
 * An exact empty reply is still a true empty: a program with no records
 * reads as zeros.
 *
 * Synthetic only: the in-memory Redis stand-in with one reply at a time made
 * malformed, and a fetch stub that answers Stripe with an empty list.
 */
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail, addProduct } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { readDirectory } from "@/lib/affiliate-directory";
import { programNumbers } from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** From now on, the reply to every command `match` picks is `bad`; the command itself still runs. */
function malform(match: (command: Command) => boolean, bad: unknown): void {
  redis.pipeline = async (commands: Command[]) => (await real(commands)).map((reply, i) => (match(commands[i]) ? bad : reply));
}
/** From now on, a pipeline holding a command `match` picks answers `bad` instead of its list of replies. */
function malformAll(match: (command: Command) => boolean, bad: unknown): void {
  redis.pipeline = async (commands: Command[]) => (commands.some(match) ? (await real(commands), bad) : real(commands)) as unknown[];
}
const restore = () => {
  redis.pipeline = real;
};

/** What a call ended in: its value, or the name of what it threw. */
async function outcome<T>(run: () => Promise<T>): Promise<T | string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function selling(email: string, handle: string, name: string) {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_program_numbers_only_a_stand_in";

  const A = "baker@example.com";
  await selling(A, "breadhouse", "Bread House");
  const loaf = await addProduct(A, "Sourdough Guide", "", "20", null);
  if (!loaf.ok) throw new Error("no product");
  const terms = { enabled: true, percent: 30, days: 30, rule: "last", payday: 15, hold: 30, buyers: true, directory: true, numbers: true, lifetime: true, rates: {} };
  await setAffiliateSetting(A, parseAffiliateSetting(terms));
  const bread = (await storeForEmail(A))!;
  const sid = bread.statsId!;

  part("An exact empty reply is still a true empty");
  is(
    "a program with no records reads as zeros",
    await outcome(() => programNumbers(bread)),
    { affiliates: 0, clicks: 0, clickSales: 0, clickEarnedCents: 0, sales: 0, earnedCents: 0, paidCents: 0, since: 0 },
  );

  const aff = (id: string, decidedAt: number) => JSON.stringify({ id, email: `${id}@example.com`, code: id.slice(0, 6), status: "approved", decidedAt });
  await redisPipeline([
    ["HSET", `nl:aff:${sid}:people`, "aaaaaaaaaaaa", aff("aaaaaaaaaaaa", Date.UTC(2026, 2, 5))],
    ["HSET", `nl:aff:${sid}:clicks`, "aaaaaaaaaaaa", "150"],
    ["HSET", `nl:aff:${sid}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", aff: "aaaaaaaaaaaa", base: 2000, rate: 30, how: "click", currency: "usd" })],
    ["HSET", `nl:aff:${sid}:payouts`, "p1", JSON.stringify({ id: "p1", aff: "aaaaaaaaaaaa", cents: 300, currency: "usd" })],
  ]);
  const exact = { affiliates: 1, clicks: 150, clickSales: 1, clickEarnedCents: 600, sales: 1, earnedCents: 600, paidCents: 300, since: Date.UTC(2026, 2, 5) };
  is("read exactly, the numbers are the records'", await outcome(() => programNumbers(bread)), exact);

  part("An unknown HGETALL reply is never zero");
  const hole: unknown[] = ["aaaaaaaaaaaa"];
  hole.length = 2;
  const getter: unknown[] = ["aaaaaaaaaaaa", "x"];
  Object.defineProperty(getter, "1", { get: () => "150", enumerable: true });
  const proxy = new Proxy(["aaaaaaaaaaaa", "150"], {});
  const shapes: [string, unknown][] = [
    ["missing (undefined)", undefined],
    ["null", null],
    ["a string", "aaaaaaaaaaaa"],
    ["a number", 0],
    ["an object", { aaaaaaaaaaaa: "150" }],
    ["an odd count", ["aaaaaaaaaaaa"]],
    ["a member that is not a string", ["aaaaaaaaaaaa", 150]],
    ["a hole", hole],
    ["a getter", getter],
    ["a Proxy", proxy],
  ];
  for (const which of ["people", "clicks", "sales", "payouts"]) {
    for (const [name, bad] of shapes) {
      malform((c) => c[0] === "HGETALL" && c[1] === `nl:aff:${sid}:${which}`, bad);
      is(`${which} answered as ${name}: UnknownReplyError, not zeros`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
      restore();
    }
  }

  part("A pipeline that answers fewer replies than were sent");
  malformAll((c) => c[0] === "HGETALL" && String(c[1]).startsWith(`nl:aff:${sid}:`), [["aaaaaaaaaaaa", aff("aaaaaaaaaaaa", 1)]]);
  is("one reply for four commands: UnknownReplyError", await outcome(() => programNumbers(bread)), "UnknownReplyError");
  malformAll((c) => c[0] === "HGETALL" && String(c[1]).startsWith(`nl:aff:${sid}:`), null);
  is("no list at all: UnknownReplyError", await outcome(() => programNumbers(bread)), "UnknownReplyError");
  restore();

  part("A click count that is not a whole number is not zero");
  for (const value of ["abc", "-1", "1.5", ""]) {
    malform((c) => c[0] === "HGETALL" && c[1] === `nl:aff:${sid}:clicks`, ["aaaaaaaaaaaa", value]);
    is(`a click count of ${JSON.stringify(value)}: UnknownReplyError`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
    restore();
  }

  part("The public directory: the row without numbers, never zeros");
  await redisPipeline([["DEL", "nl:dir:page"]]);
  malform((c) => c[0] === "HGETALL" && c[1] === `nl:aff:${sid}:payouts`, null);
  const rows = await readDirectory();
  restore();
  const row = rows.find((r) => r.handle === "breadhouse");
  is("the program is still listed", row?.handle, "breadhouse");
  is("with no numbers rather than 0 affiliates and $0 paid", row?.numbers, null);
  const [kept] = await redisPipeline([["GET", "nl:dir:page"]]);
  const keptRow = typeof kept === "string" ? (JSON.parse(kept) as { handle: string; numbers: unknown }[]).find((r) => r.handle === "breadhouse") : undefined;
  is("and any page kept for the next visitors holds no zeros for it", keptRow === undefined || keptRow.numbers === null, true);
  await redisPipeline([["DEL", "nl:dir:page"]]);
  is("read exactly again, the directory shows the real numbers", (await readDirectory()).find((r) => r.handle === "breadhouse")?.numbers?.paidCents, 300);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
