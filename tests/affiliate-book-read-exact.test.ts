/**
 * The affiliate book is read exactly (lib/affiliates.ts, readBook; rule 24 sweep of Claude 4, cloud F, 11 November 2026).
 *
 * (GRAVE, money) readBook read its seven hashes with a lenient reader: a reply of another shape, or missing, became
 * an empty hash. The payouts hash read that way lost every payout already made, so the affiliate showed the whole
 * commission as owed again: the payout file, "Mark as paid" and the PayPal payment on payday (lib/paypal-payouts.ts)
 * then paid it a second time, from the creator's money. The other hashes read the same way dropped people, sales,
 * shares or leads without a word. Now each reply is read exactly, and one that is not known throws
 * UnknownReplyError: nothing is shown as owed, and nothing is paid, on a book that could not be read.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { addPayout, idleSweep, readBook } from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_book_exact_only";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const person = JSON.stringify({ id: ANA, email: "ana.payee@example.com", code: "ana", status: "approved", appliedAt: (NOW - 90 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = JSON.stringify({ ref: "cs_bread1", pi: "pi_cs_bread1", aff: ANA, at: NOW - 60 * 86_400, product: "prod01", title: "Bread course", base: 10_000, total: 10_000, currency: "usd", rate: 30, self: false, how: "click" });

const real = redis.pipeline.bind(redis);
type Pipe = typeof real;
/** Answers the book's read (readBook's seven hashes, idleSweep's four) with one hash's reply replaced; undefined: Redis itself. */
let garble: { key: RegExp; reply: unknown } | undefined;
redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
  const replies = await real(commands);
  if (!garble || commands.length < 4 || !commands.every((c) => c[0] === "HGETALL")) return replies;
  const g = garble;
  return replies.map((r, i) => (g.key.test(String(commands[i][1])) ? g.reply : r));
}) as Pipe;

const owedTo = async (store: Parameters<typeof readBook>[0]) =>
  readBook(store).then(
    (book) => book.rows.find((r) => r.affiliate.id === ANA)?.payable ?? 0,
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
  );

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBookExact", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await real([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_bread1", sale],
  ]);

  part("Control: a commission owed, then paid");
  is("the sale's commission is owed", await owedTo(store), 3000);
  await addPayout(store, { aff: ANA, cents: 3000, currency: store.currency, date: "2026-11-01", reference: "Bank transfer" });
  is("once paid, nothing is owed", await owedTo(store), 0);

  part("The payouts hash answered in a shape that cannot be read");
  for (const [label, reply] of [
    ["a string", "?"],
    ["null", null],
    ["an odd-length list", ["x"]],
    ["a number", 0],
  ] as const) {
    garble = { key: /:payouts$/, reply };
    is(`payouts answered ${label}: never owed again, the book is not known`, await owedTo(store), "unknown");
  }

  part("A payout row this code did not write: the book is not known, never owed again (Revisor 1 on #3719, MEDIUM)");
  garble = undefined;
  for (const [label, row] of [
    ["cents as text", JSON.stringify({ id: "p_odd1", aff: ANA, cents: "1250", currency: store.currency, date: "2026-11-02", reference: "x" })],
    ["not JSON", "{not json"],
    ["no affiliate", JSON.stringify({ id: "p_odd1", cents: 1250, currency: store.currency })],
    ["fractional cents", JSON.stringify({ id: "p_odd1", aff: ANA, cents: 12.5, currency: store.currency })],
    ["a currency Stripe has no code like", JSON.stringify({ id: "p_odd1", aff: ANA, cents: 1250, currency: "US Dollars" })],
  ] as const) {
    await real([["HSET", `nl:aff:${statsId}:payouts`, "p_odd1", row]]);
    is(`a payout row with ${label}: the book is not known`, await owedTo(store), "unknown");
  }
  await real([["HDEL", `nl:aff:${statsId}:payouts`, "p_odd1"]]);
  is("(the odd row gone: nothing owed)", await owedTo(store), 0);

  part("The people or sales hash answered in a shape that cannot be read");
  for (const key of [/:people$/, /:sales$/, /:shares$/, /:clicks$/, /:paid$/, /:leads$/]) {
    garble = { key, reply: "?" };
    is(`${key.source} answered "?": the book is not known`, await owedTo(store), "unknown");
  }
  garble = undefined;
  is("(answered again: nothing owed)", await owedTo(store), 0);

  part("Removing idle affiliates: a sales hash that does not read never makes anyone look idle");
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, idle: 90 });
  const idleStore = { ...(await storeForEmail(OWNER))!, affiliates: { ...(await storeForEmail(OWNER))!.affiliates, idle: 90, idleOn: NOW - 400 * 86_400 } };
  const later = (NOW + 400 * 86_400) * 1000;
  garble = { key: /:sales$/, reply: "?" };
  const swept = await idleSweep(idleStore, later).then(
    (r) => `removed ${r.removed}, warned ${r.warned}`,
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
  );
  garble = undefined;
  is("the sweep stops on a book it cannot read", swept, "unknown");
  const [kept] = await real([["HGET", `nl:aff:${statsId}:people`, ANA]]);
  is("(the affiliate is still approved)", JSON.parse(String(kept)).status, "approved");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
