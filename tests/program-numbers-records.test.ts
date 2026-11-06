/**
 * A program's public numbers (lib/affiliates.ts, programNumbers) add up the
 * records inside four exactly shaped HGETALL replies. A record that is not in
 * the shape its writer gives it (writeAffiliate, writeReferral, addPayout) is
 * never read as nothing: an affiliate that is not JSON, a sale whose base is
 * missing or a word, a payment written down as text. Before, each was dropped
 * or read as 0, and the public directory showed "0 affiliates / $0 paid / 1
 * sale earning $0". Now programNumbers throws UnknownReplyError
 * (lib/redis-reply.ts) and the directory shows that program's row without
 * numbers (lib/affiliate-directory.ts, readDirectory).
 *
 * Only this public read is exact. The shared parsers and their other callers
 * are unchanged. What older writers really left keeps reading as before: a
 * sale with no `how` (a click), the older `byCode` spelling (a code), a sale
 * or a payment with no currency (US dollars), a sale in another currency or a
 * self-purchase (not counted), an affiliate who is pending, declined or
 * removed (not counted).
 *
 * Synthetic only: the in-memory Redis stand-in, records written straight into
 * it, and a fetch stub that answers Stripe with an empty list.
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

  const DECIDED = Date.UTC(2026, 2, 5);
  const affiliate = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id: "aaaaaaaaaaaa", email: "aaaaaaaaaaaa@example.com", code: "aaaaaa", status: "approved", decidedAt: DECIDED, ...extra });
  const sale = (extra: Record<string, unknown> = {}) => JSON.stringify({ ref: "cs_1", aff: "aaaaaaaaaaaa", base: 2000, rate: 30, how: "click", currency: "usd", ...extra });
  const payout = (extra: Record<string, unknown> = {}) => JSON.stringify({ id: "p1", aff: "aaaaaaaaaaaa", cents: 300, currency: "usd", ...extra });

  /** Replaces the program's records with exactly these: one affiliate, one sale and one payment each by default. */
  async function records(write: { people?: string[]; sales?: string[]; payouts?: string[] } = {}): Promise<void> {
    const people = write.people ?? [affiliate()];
    const sales = write.sales ?? [sale()];
    const payouts = write.payouts ?? [payout()];
    const hset = (key: string, values: string[]) => (values.length ? [["HSET", key, ...values.flatMap((v, i) => [`f${i}`, v])]] : []);
    await redisPipeline([
      ["DEL", `nl:aff:${sid}:people`, `nl:aff:${sid}:clicks`, `nl:aff:${sid}:sales`, `nl:aff:${sid}:payouts`],
      ...hset(`nl:aff:${sid}:people`, people),
      ...hset(`nl:aff:${sid}:sales`, sales),
      ...hset(`nl:aff:${sid}:payouts`, payouts),
    ]);
  }

  part("Records in their writers' shape are read as they are");
  await records();
  is(
    "one affiliate, one click sale, one payment",
    await outcome(() => programNumbers(bread)),
    { affiliates: 1, clicks: 0, clickSales: 1, clickEarnedCents: 600, sales: 1, earnedCents: 600, paidCents: 300, since: DECIDED },
  );

  part("An affiliate record of an unknown shape is never 'no affiliate'");
  const badPeople: [string, string][] = [
    ["not JSON", "{not json"],
    ["JSON that is not an object (a number)", "5"],
    ["JSON null", "null"],
    ["a list", "[]"],
    ["an id of another shape", affiliate({ id: "short" })],
    ["no email", affiliate({ email: undefined })],
    ["a status no writer gives", affiliate({ status: "aproved" })],
    ["no status", affiliate({ status: undefined })],
    ["a decision time that is a word", affiliate({ decidedAt: "yesterday" })],
    ["a negative decision time", affiliate({ decidedAt: -1 })],
  ];
  for (const [name, raw] of badPeople) {
    await records({ people: [raw] });
    is(`an affiliate with ${name}: UnknownReplyError`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
  }

  part("A sale record of an unknown shape is never 'no sale' or 'earned $0'");
  const badSales: [string, string][] = [
    ["not JSON", "{not json"],
    ["JSON that is not an object (a string)", '"cs_1"'],
    ["no aff", sale({ aff: undefined })],
    ["no base", sale({ base: undefined })],
    ["a base that is a word", sale({ base: "unconfirmed" })],
    ["a negative base", sale({ base: -2000 })],
    ["a base that is not whole", sale({ base: 20.5 })],
    ["no rate", sale({ rate: undefined })],
    ["a rate that is a word", sale({ rate: "thirty" })],
    ["a negative rate", sale({ rate: -30 })],
    ["a way of crediting no writer gives", sale({ how: "clik" })],
    ["a self flag that is a word", sale({ self: "yes" })],
    ["a currency of another shape", sale({ currency: "USD" })],
    ["a currency that is a number", sale({ currency: 840 })],
    ["a byCode that is a word", sale({ how: undefined, byCode: "yes" })],
  ];
  for (const [name, raw] of badSales) {
    await records({ sales: [raw] });
    is(`a sale with ${name}: UnknownReplyError`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
  }

  part("A payment record of an unknown shape is never '$0 paid'");
  const badPayouts: [string, string][] = [
    ["not JSON", "{not json"],
    ["JSON that is not an object (true)", "true"],
    ["no aff", payout({ aff: undefined })],
    ["cents written as text", payout({ cents: "300" })],
    ["no cents", payout({ cents: undefined })],
    ["negative cents", payout({ cents: -300 })],
    ["cents that are not whole", payout({ cents: 3.5 })],
    ["a currency of another shape", payout({ currency: "Dollars" })],
  ];
  for (const [name, raw] of badPayouts) {
    await records({ payouts: [raw] });
    is(`a payment with ${name}: UnknownReplyError`, await outcome(() => programNumbers(bread)), "UnknownReplyError");
  }

  part("What older writers really left still reads as before");
  await records({ sales: [sale({ how: undefined })] });
  is("a sale with no 'how' is a click", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 1, clicks: 0, clickSales: 1, clickEarnedCents: 600, sales: 1, earnedCents: 600, paidCents: 300, since: DECIDED,
  });
  await records({ sales: [sale({ how: undefined, byCode: true })] });
  is("the older byCode spelling is a code, not a click", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 1, clicks: 0, clickSales: 0, clickEarnedCents: 0, sales: 1, earnedCents: 600, paidCents: 300, since: DECIDED,
  });
  await records({ sales: [sale({ currency: undefined })], payouts: [payout({ currency: undefined })] });
  is("a sale and a payment with no currency are US dollars", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 1, clicks: 0, clickSales: 1, clickEarnedCents: 600, sales: 1, earnedCents: 600, paidCents: 300, since: DECIDED,
  });
  await records({ sales: [sale({ currency: "eur" }), sale({ ref: "cs_2", self: true })], payouts: [payout({ currency: "eur" })] });
  is("a sale and a payment in another currency, and a self-purchase, are not counted", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 1, clicks: 0, clickSales: 0, clickEarnedCents: 0, sales: 0, earnedCents: 0, paidCents: 0, since: DECIDED,
  });
  await records({
    people: [affiliate({ status: "pending", decidedAt: 0 }), affiliate({ id: "bbbbbbbbbbbb", status: "declined" }), affiliate({ id: "cccccccccccc", status: "removed" })],
    sales: [],
    payouts: [],
  });
  is("pending, declined and removed affiliates are not counted", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 0, clicks: 0, clickSales: 0, clickEarnedCents: 0, sales: 0, earnedCents: 0, paidCents: 0, since: 0,
  });
  await records({ sales: [sale({ rate: 0 })], payouts: [payout({ cents: 0 })] });
  is("a sale at 0% and a payment of 0 are records, read as they are", (await outcome(() => programNumbers(bread))) as unknown, {
    affiliates: 1, clicks: 0, clickSales: 1, clickEarnedCents: 0, sales: 1, earnedCents: 0, paidCents: 0, since: DECIDED,
  });

  part("The public directory: the row without numbers, never zeros");
  await records({ people: ["{not json"], sales: [sale({ base: undefined })], payouts: ["{not json"] });
  await redisPipeline([["DEL", "nl:dir:page"]]);
  const row = (await readDirectory()).find((r) => r.handle === "breadhouse");
  is("the program is still listed", row?.handle, "breadhouse");
  is("with no numbers rather than 0 affiliates, $0 paid and a sale earning $0", row?.numbers, null);
  const [kept] = await redisPipeline([["GET", "nl:dir:page"]]);
  const keptRow = typeof kept === "string" ? (JSON.parse(kept) as { handle: string; numbers: unknown }[]).find((r) => r.handle === "breadhouse") : undefined;
  is("and any page kept for the next visitors holds no zeros for it", keptRow === undefined || keptRow.numbers === null, true);
  await records();
  await redisPipeline([["DEL", "nl:dir:page"]]);
  is("records in shape again, the directory shows the real numbers", (await readDirectory()).find((r) => r.handle === "breadhouse")?.numbers?.paidCents, 300);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
