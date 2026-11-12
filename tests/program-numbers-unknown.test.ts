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
 * A record inside an exact reply that cannot be read (not JSON, not the
 * record it should be, a sale whose base or share is not a number, a
 * currency of another shape) is of an unknown shape too, never dropped or
 * read as 0. Older records still read as before: `byCode` for `how`, and no
 * currency for US dollars.
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

  part("A record inside an exact reply that cannot be read is not zero either");
  // Findings of Claude 6 (6697008326) and Codex T (review 5807888762) on #2950:
  // an entry that does not parse, or a sale whose base or share is not a
  // number, was dropped or read as 0, so the directory said "0 affiliates",
  // "$0 paid" or "1 sale earning $0".
  const bad: [string, string, string, string][] = [
    ["an affiliate that is not JSON", "people", "bbbbbbbbbbbb", "{not json"],
    ["an affiliate that is not an affiliate", "people", "bbbbbbbbbbbb", JSON.stringify({ id: "bbbbbbbbbbbb" })],
    ["a sale that is not JSON", "sales", "cs_bad", "{not json"],
    ["a sale with no base", "sales", "cs_bad", JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", rate: 30, how: "click", currency: "usd" })],
    ["a sale whose base is a word", "sales", "cs_bad", JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", base: "unconfirmed", rate: 30, how: "click", currency: "usd" })],
    ["a sale with no share", "sales", "cs_bad", JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", base: 2000, how: "click", currency: "usd" })],
    ["a sale whose share is text", "sales", "cs_bad", JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", base: 2000, rate: "30", how: "click", currency: "usd" })],
    ["a sale whose currency is of another shape", "sales", "cs_bad", JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", base: 2000, rate: 30, how: "click", currency: "USD" })],
    ["a payment that is not JSON", "payouts", "p_bad", "{not json"],
    ["a payment whose amount is text", "payouts", "p_bad", JSON.stringify({ id: "p_bad", aff: "aaaaaaaaaaaa", cents: "300", currency: "usd" })],
    ["a payment whose currency is of another shape", "payouts", "p_bad", JSON.stringify({ id: "p_bad", aff: "aaaaaaaaaaaa", cents: 300, currency: 840 })],
  ];
  for (const [name, which, field, value] of bad) {
    await redisPipeline([["HSET", `nl:aff:${sid}:${which}`, field, value]]);
    is(`${name}: UnknownReplyError, not zeros`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
    await redisPipeline([["HDEL", `nl:aff:${sid}:${which}`, field]]);
  }
  is("with the bad record gone, the numbers are the records' again", await outcome(() => programNumbers(bread)), exact);

  // Older records still read as they always did: a sale written before `how`
  // (with `byCode`), and a sale or a payment written before stores had a
  // currency, which were in US dollars.
  await redisPipeline([
    ["HSET", `nl:aff:${sid}:sales`, "cs_old", JSON.stringify({ ref: "cs_old", aff: "aaaaaaaaaaaa", base: 1000, rate: 30, byCode: true })],
    ["HSET", `nl:aff:${sid}:payouts`, "p_old", JSON.stringify({ id: "p_old", aff: "aaaaaaaaaaaa", cents: 100 })],
  ]);
  is(
    "an older sale by code and older records with no currency still count, in US dollars",
    await outcome(() => programNumbers(bread)),
    { ...exact, sales: 2, earnedCents: 900, paidCents: 400 },
  );
  await redisPipeline([
    ["HDEL", `nl:aff:${sid}:sales`, "cs_old"],
    ["HDEL", `nl:aff:${sid}:payouts`, "p_old"],
  ]);

  part("A record in a shape no writer produces is not a number either");
  // Claude 2's money review of #3254 (6726841494): each value was checked to
  // be finite, but not to be what its writers store, nor the totals made from
  // it. The writers store a sale's base in whole cents from 0 up (Stripe's
  // amount less its tax, or PayPal's), its share from 0 to MAX_COMMISSION (90;
  // a blended share has two decimals), `self` as true or false and `how` as
  // click, code, buyer, partner or contact; a payment in whole cents from 1
  // up. Anything else, and any total that is not a whole number JavaScript
  // holds exactly, is of an unknown shape: never "$∞", "$0" or 10× a sale.
  const sale = (extra: Record<string, unknown>) => JSON.stringify({ ref: "cs_bad", aff: "aaaaaaaaaaaa", base: 2000, rate: 30, how: "click", currency: "usd", ...extra });
  const pay = (cents: unknown) => JSON.stringify({ id: "p_bad", aff: "aaaaaaaaaaaa", cents, currency: "usd" });
  const odd: [string, [string, string, string][]][] = [
    ["a sale whose share times its base overflows to Infinity", [["sales", "cs_bad", sale({ base: 1e307, rate: 100 })]]],
    ["a sale whose base is past what JavaScript holds exactly", [["sales", "cs_bad", sale({ base: 2 ** 53 })]]],
    ["a sale whose commission is past what JavaScript holds exactly", [["sales", "cs_bad", sale({ base: Number.MAX_SAFE_INTEGER, rate: 90 })]]],
    ["two sales whose commissions add up past what JavaScript holds exactly", [["sales", "cs_bad", sale({ base: 9e15, rate: 90 })], ["sales", "cs_bad2", sale({ ref: "cs_bad2", base: 9e15, rate: 90 })]]],
    ["two payments that add up to Infinity", [["payouts", "p_bad", pay(1e308)], ["payouts", "p_bad2", JSON.stringify({ id: "p_bad2", aff: "aaaaaaaaaaaa", cents: 1e308, currency: "usd" })]]],
    ["two payments that add up past what JavaScript holds exactly", [["payouts", "p_bad", pay(Number.MAX_SAFE_INTEGER)], ["payouts", "p_bad2", JSON.stringify({ id: "p_bad2", aff: "aaaaaaaaaaaa", cents: Number.MAX_SAFE_INTEGER, currency: "usd" })]]],
    ["a payment of a negative amount", [["payouts", "p_bad", pay(-300)]]],
    ["a payment of a fraction of a cent", [["payouts", "p_bad", pay(0.5)]]],
    ["a payment of nothing", [["payouts", "p_bad", pay(0)]]],
    ["a sale with a negative base", [["sales", "cs_bad", sale({ base: -2000 })]]],
    ["a sale with a fraction of a cent as its base", [["sales", "cs_bad", sale({ base: 2000.5 })]]],
    ["a sale whose share is above the program's most (90)", [["sales", "cs_bad", sale({ rate: 1000 })]]],
    ["a sale whose share is 91", [["sales", "cs_bad", sale({ rate: 91 })]]],
    ["a sale whose share is negative", [["sales", "cs_bad", sale({ rate: -30 })]]],
    ["a sale whose `self` is the text \"true\"", [["sales", "cs_bad", sale({ self: "true" })]]],
    ["a sale whose `self` is 1", [["sales", "cs_bad", sale({ self: 1 })]]],
    ["a sale whose `how` is unknown", [["sales", "cs_bad", sale({ how: "weird" })]]],
    ["a sale whose `how` is not text", [["sales", "cs_bad", sale({ how: 1 })]]],
    ["a sale whose `byCode` is the text \"true\"", [["sales", "cs_bad", sale({ how: undefined, byCode: "true" })]]],
  ];
  for (const [name, records] of odd) {
    await redisPipeline(records.map(([which, field, value]) => ["HSET", `nl:aff:${sid}:${which}`, field, value]));
    is(`${name}: UnknownReplyError, not a number`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
    await redisPipeline(records.map(([which, field]) => ["HDEL", `nl:aff:${sid}:${which}`, field]));
  }
  is("with the odd records gone, the numbers are the records' again", await outcome(() => programNumbers(bread)), exact);

  // What the writers do store still reads exactly: a sale of nothing at no
  // share (`Number(meta.via_rate) || 0`), a blended share with two decimals,
  // the program's most (90), `self` written as false or true, every `how`
  // a writer writes, and the smallest payment the creator can write down.
  await redisPipeline([
    ["HSET", `nl:aff:${sid}:sales`, "cs_zero", sale({ ref: "cs_zero", base: 0, rate: 0, self: false })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_blend", sale({ ref: "cs_blend", base: 1000, rate: 27.35, how: "code" })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_most", sale({ ref: "cs_most", base: 1000, rate: 90, how: "buyer" })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_contact", sale({ ref: "cs_contact", base: 1000, rate: 10, how: "contact" })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_partner", sale({ ref: "cs_partner", base: 1000, rate: 10, how: "partner" })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_self", sale({ ref: "cs_self", base: 1000, rate: 30, self: true })],
    ["HSET", `nl:aff:${sid}:sales`, "cs_bycode", sale({ ref: "cs_bycode", base: 1000, rate: 10, how: undefined, byCode: false })],
    ["HSET", `nl:aff:${sid}:payouts`, "p_one", pay(1)],
  ]);
  is(
    "what the writers store still reads exactly (an own purchase not counted)",
    await outcome(() => programNumbers(bread)),
    // 600 + 0 + 273 + 900 + 100 + 100 + 100 earned; the old sale with byCode false is a click.
    { ...exact, clickSales: 3, clickEarnedCents: 700, sales: 7, earnedCents: 2073, paidCents: 301 },
  );
  await redisPipeline([
    ...["cs_zero", "cs_blend", "cs_most", "cs_contact", "cs_partner", "cs_self", "cs_bycode"].map((f) => ["HDEL", `nl:aff:${sid}:sales`, f]),
    ["HDEL", `nl:aff:${sid}:payouts`, "p_one"],
  ]);

  await redisPipeline([["DEL", "nl:dir:page"], ["HSET", `nl:aff:${sid}:sales`, "cs_bad", sale({ base: 1e307, rate: 100 })]]);
  const overflowRow = (await readDirectory()).find((r) => r.handle === "breadhouse");
  is("the directory shows the row with an overflowing sale without numbers, never $∞", overflowRow?.numbers, null);
  const [keptOverflow] = await redisPipeline([["GET", "nl:dir:page"]]);
  const keptOverflowRow = typeof keptOverflow === "string" ? (JSON.parse(keptOverflow) as { handle: string; numbers: unknown }[]).find((r) => r.handle === "breadhouse") : undefined;
  is("and the page kept for the next visitors holds no $0 for it", keptOverflowRow === undefined || keptOverflowRow.numbers === null, true);
  await redisPipeline([["DEL", "nl:dir:page"], ["HDEL", `nl:aff:${sid}:sales`, "cs_bad"]]);

  await redisPipeline([["DEL", "nl:dir:page"], ["HSET", `nl:aff:${sid}:payouts`, "p_bad", "{not json"]]);
  is("the directory shows the row with a bad record without numbers", (await readDirectory()).find((r) => r.handle === "breadhouse")?.numbers, null);
  await redisPipeline([["DEL", "nl:dir:page"], ["HDEL", `nl:aff:${sid}:payouts`, "p_bad"]]);

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
