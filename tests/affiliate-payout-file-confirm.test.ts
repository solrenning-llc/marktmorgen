/**
 * "Mark as paid" for a downloaded payout file (app/api/store/affiliates/payout-batch, POST) writes down exactly
 * what that file paid, never what the book says is owed at the moment of the confirmation (Claude 1,
 * C1-20261112-1000-C7-141, item 2c).
 *
 * The scenario that lost money: the file paid Ana $30; before the creator confirmed, new sales came in for Ana and
 * Bea; the confirmation wrote $105 as paid, so the $75 nobody sent was never owed again. Checked on the real route,
 * the real readBook and the real payout writer over the Redis stub, Stripe answered by a synthetic fetch:
 *
 *   - the file's own lines are kept when it is handed out, under an id the answer names (X-Payout-File);
 *   - confirming that file writes $30 for Ana and nothing for Bea; the $75 stays owed;
 *   - confirming it twice, one after the other or at the same instant, writes it once;
 *   - an unknown, missing or expired file writes nothing and says so;
 *   - while the automatic PayPal payout holds the store's payout lock, nothing is written;
 *   - a file superseded by a later one already written down (every file is a snapshot of the whole balance) is
 *     refused, never written on top of it (review of #3906, Claude 1, MEDIUM 2);
 *   - a file that overlaps a PayPal payment on its way, or a payout written after it was downloaded, is refused;
 *   - `left` is what the next file would pay, not every row's balance (review of #3906, LEVE 3).
 */
import { NextRequest } from "next/server";
import { readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET, POST } from "@/app/api/store/affiliates/payout-batch/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_payout_file_confirm_only";

const OWNER = "baker@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "bbbbbbbbbbbb";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const person = (id: string, name: string) =>
  JSON.stringify({ id, email: `${name}@example.com`, code: name, status: "approved", appliedAt: (NOW - 90 * DAY) * 1000, decidedAt: 1, note: "" });
// 30% of base: a base of 10,000 earns 3,000 ($30).
const sale = (ref: string, aff: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 60 * DAY, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Bakery", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPayFile01", true);
  await setSubscription(OWNER, { customerId: "cus_PayFile0001", subscriptionId: "sub_PayFile0001", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const session = await openSession(OWNER);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const sales = `nl:aff:${statsId}:sales`;
  const payoutsKey = `nl:aff:${statsId}:payouts`;

  const download = async () => {
    const response = await GET(new NextRequest("https://marktmorgen.com/api/store/affiliates/payout-batch?provider=paypal", { headers: { cookie } }));
    return { status: response.status, body: await response.text(), file: response.headers.get("x-payout-file") ?? "" };
  };
  const confirm = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    const response = await POST(
      new NextRequest("https://marktmorgen.com/api/store/affiliates/payout-batch", {
        method: "POST",
        headers: { cookie, "content-type": "application/json", "content-length": String(body.length) },
        body,
      }),
    );
    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
  };
  const paidTo = async () => {
    const flat = (await redis.pipeline([["HGETALL", payoutsKey]]))[0] as string[] | null;
    const paid: Record<string, number> = {};
    for (let i = 1; i < (flat ?? []).length; i += 2) {
      const payout = JSON.parse(flat![i]) as { aff: string; cents: number };
      paid[payout.aff] = (paid[payout.aff] ?? 0) + payout.cents;
    }
    return paid;
  };
  const owed = async () => Object.fromEntries((await readBook(store)).rows.map((row) => [row.affiliate.id, row.owed]));

  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea")],
    ["HSET", sales, "cs_ana1", sale("cs_ana1", ANA, 10_000)],
  ]);

  part("The file is handed out with its own id");
  const file = await download();
  is("the file is handed out", file.status, 200);
  is("it pays Ana $30", file.body.includes(",30.00,USD,"), true);
  is("it names its own id", /^[0-9a-f]{24}$/.test(file.file), true);

  part("New sales before the confirmation stay owed");
  await redis.pipeline([
    ["HSET", sales, "cs_ana2", sale("cs_ana2", ANA, 15_000)],
    ["HSET", sales, "cs_bea1", sale("cs_bea1", BEA, 10_000)],
  ]);
  is("the book now owes $105 in all", await owed(), { [ANA]: 7_500, [BEA]: 3_000 });

  part("Refused without a file it can match");
  is("no file named: refused", (await confirm({ date: "2026-11-12", reference: "PayPal batch 1" })).status, 409);
  is("an unknown file: refused", (await confirm({ date: "2026-11-12", reference: "PayPal batch 1", file: "f".repeat(24) })).status, 409);
  is("nothing is written for either", await paidTo(), {});

  part("Refused while the automatic PayPal payout holds the lock");
  await redis.pipeline([["SET", `nl:pp:${statsId}:lock`, "someone-else", "EX", 120]]);
  const busy = await confirm({ date: "2026-11-12", reference: "PayPal batch 1", file: file.file });
  is("busy, nothing written", [busy.status, busy.data.error, await paidTo()], [409, "busy", {}]);
  await redis.pipeline([["DEL", `nl:pp:${statsId}:lock`]]);

  part("Exactly what the file paid");
  const [first, second] = await Promise.all([
    confirm({ date: "2026-11-12", reference: "PayPal batch 1", file: file.file }),
    confirm({ date: "2026-11-12", reference: "PayPal batch 1", file: file.file }),
  ]);
  is("one of two clicks at once writes it", [first.data.ok, second.data.ok].filter(Boolean).length, 1);
  is("$30 for Ana, nothing for Bea", await paidTo(), { [ANA]: 3_000 });
  is("the $75 nobody sent is still owed", await owed(), { [ANA]: 4_500, [BEA]: 3_000 });
  const winner = first.data.ok ? first.data : second.data;
  is("the answer says what was written and what is still owed", [winner.written, winner.cents, winner.left], [1, 3_000, 7_500]);

  part("Confirmed again later: written once");
  const again = await confirm({ date: "2026-11-12", reference: "PayPal batch 1", file: file.file });
  is("the file is used up", [again.status, again.data.error], [409, "file"]);
  is("still $30 for Ana", await paidTo(), { [ANA]: 3_000 });

  part("The next file pays what is owed now");
  const next = await download();
  is("Ana's $45 and Bea's $30", [next.body.includes(",45.00,USD,"), next.body.includes(",30.00,USD,")], [true, true]);
  is("a new id", next.file !== file.file && /^[0-9a-f]{24}$/.test(next.file), true);
  await redis.pipeline([["DEL", `nl:affpay:${statsId}`]]);
  is("an expired file: refused", [(await confirm({ date: "2026-11-12", reference: "x", file: next.file })).status, await paidTo()], [409, { [ANA]: 3_000 }]);

  part("A file superseded by a later one is never written down on top of it");
  const f1 = await download();
  is("f1 pays Ana $45 and Bea $30", [f1.body.includes(",45.00,USD,"), f1.body.includes(",30.00,USD,")], [true, true]);
  await redis.pipeline([["HSET", sales, "cs_ana3", sale("cs_ana3", ANA, 10_000)]]);
  const f2 = await download();
  is("f2 pays Ana $75, f1's $45 included", f2.body.includes(",75.00,USD,"), true);
  const paidF2 = await confirm({ date: "2026-11-12", reference: "PayPal batch 2", file: f2.file });
  is("f2 is written down", [paidF2.status, paidF2.data.cents, paidF2.data.left], [200, 10_500, 0]);
  is("nobody is owed anything", await owed(), { [ANA]: 0, [BEA]: 0 });
  const paidF1 = await confirm({ date: "2026-11-12", reference: "PayPal batch 1b", file: f1.file });
  is("f1 is refused afterward", [paidF1.status, paidF1.data.ok], [409, false]);
  is("and Ana is never paid twice", [await paidTo(), await owed()], [{ [ANA]: 10_500, [BEA]: 3_000 }, { [ANA]: 0, [BEA]: 0 }]);

  part("A file overlapping a PayPal payment on its way is refused");
  await redis.pipeline([["HSET", sales, "cs_bea2", sale("cs_bea2", BEA, 10_000)]]);
  const f3 = await download();
  is("f3 pays Bea $30", f3.body.includes(",30.00,USD,"), true);
  await redis.pipeline([["HSET", `nl:pp:open:${statsId}`, "?nl-test-batch", JSON.stringify({ at: Date.now(), currency: "usd", lines: [{ a: BEA, c: 3_000 }] })]]);
  const overlap = await confirm({ date: "2026-11-12", reference: "x", file: f3.file });
  is("refused as out of date, nothing written", [overlap.status, overlap.data.error, (await paidTo())[BEA]], [409, "stale", 3_000]);
  await redis.pipeline([["DEL", `nl:pp:open:${statsId}`]]);

  part("A file overlapping a payout written by hand after it was downloaded is refused");
  const f4 = await download();
  await redis.pipeline([["HSET", payoutsKey, "abcdefabcdef", JSON.stringify({ id: "abcdefabcdef", aff: BEA, cents: 3_000, currency: "usd", date: "2026-11-12", reference: "cash", at: Date.now() + 1_000 })]]);
  const byHand = await confirm({ date: "2026-11-12", reference: "x", file: f4.file });
  is("refused as out of date, nothing written", [byHand.status, byHand.data.error, (await paidTo())[BEA]], [409, "stale", 6_000]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
