/**
 * A payout file written down only in part never looks complete (Codex N1 on #3906 @fcfbff44c4, MEDIUM, money, and its
 * two LOWs; the shape of Codex L's fix candidate, L-20261120-2139).
 *
 *   - A file pays Ana and Bea, and Bea's affiliate record is gone before "Write the batch down": Ana's line is written,
 *     the answer is a 409 "unrecorded" naming how many lines and how much could not be written (never who), and the
 *     file is kept, never dropped while a line it paid is not in the book. A retry writes nothing twice and refuses the
 *     same way.
 *   - A line already in the book (a retry after a lost answer) is counted apart, never as written now (LOW 2).
 *   - With more than one file waiting, the studio never confirms the newest one by default (LOW 1).
 *
 * The real route, the real readBook and the real payout writer over the Redis stub; Stripe answered by a synthetic fetch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { payoutIdForFileLine } from "@/lib/affiliate-payouts";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GET, POST } from "@/app/api/store/affiliates/payout-batch/route";
import { postBatch } from "@/components/affiliate-studio";
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

  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea")],
    ["HSET", sales, "cs_ana1", sale("cs_ana1", ANA, 10_000)],
  ]);

  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea")],
    ["HSET", sales, "cs_ana1", sale("cs_ana1", ANA, 10_000)],
    ["HSET", sales, "cs_bea1", sale("cs_bea1", BEA, 10_000)],
  ]);
  const kept = async (id: string) => (await redis.pipeline([["HEXISTS", `nl:affpay:${statsId}`, id]]))[0];

  part("A line whose affiliate is gone: the file is not written down as complete");
  const file = await download();
  is("the file pays Ana and Bea $30 each", [file.status, file.body.split(",30.00,USD,").length - 1], [200, 2]);
  await redis.pipeline([["HDEL", `nl:aff:${statsId}:people`, BEA]]);
  const partial = await confirm({ date: "2026-11-20", reference: "PayPal batch 7", file: file.file });
  is("refused as unrecorded, with what was and was not written",
    [partial.status, partial.data.ok, partial.data.error, partial.data.written, partial.data.unrecorded, partial.data.unrecordedCents],
    [409, false, "unrecorded", 1, 1, 3_000]);
  is("the answer never names the affiliate that is gone", JSON.stringify(partial.data).includes(BEA) || JSON.stringify(partial.data).includes("bea@"), false);
  is("Ana's line is in the book", await paidTo(), { [ANA]: 3_000 });
  is("the file is kept", await kept(file.file), 1);

  part("A retry writes nothing twice and refuses the same way");
  const retry = await confirm({ date: "2026-11-20", reference: "PayPal batch 7", file: file.file });
  is("refused again, Ana's line already in the book",
    [retry.status, retry.data.error, retry.data.written, retry.data.held, retry.data.unrecorded], [409, "unrecorded", 0, 1, 1]);
  is("Ana is still paid once", await paidTo(), { [ANA]: 3_000 });
  is("the file is still kept", await kept(file.file), 1);

  part("A line already in the book is counted apart, never as written now");
  await redis.pipeline([["DEL", `nl:affpay:${statsId}`], ["HSET", sales, "cs_ana2", sale("cs_ana2", ANA, 10_000)]]);
  const solo = await download();
  is("the next file pays Ana $30", [solo.status, solo.body.includes(",30.00,USD,"), solo.body.split(",USD,").length - 1], [200, true, 1]);
  // The same line written by a first confirmation whose answer was lost: its deterministic id, before the retry.
  await redis.pipeline([["HSET", payoutsKey, payoutIdForFileLine(solo.file, ANA), JSON.stringify({
    id: payoutIdForFileLine(solo.file, ANA), aff: ANA, cents: 3_000, currency: "usd", date: "2026-11-20", reference: "PayPal batch 8", at: Date.now(),
  })]]);
  const lost = await confirm({ date: "2026-11-20", reference: "PayPal batch 8", file: solo.file });
  is("written down, nothing written now, one line already there", [lost.status, lost.data.ok, lost.data.written, lost.data.cents, lost.data.held], [200, true, 0, 0, 1]);
  is("Ana is paid $60 in all, never $90", await paidTo(), { [ANA]: 6_000 });

  part("The studio never confirms the newest file by default");
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  is("no fallback to the newest of several files", /\?\? files\[0\] \?\? null/.test(studio), false);
  is("one file is taken as it is; several need a choice", studio.includes("files.length === 1 ? files[0] : null"), true);
  is("the choice is required, with no file picked at first", [studio.includes('<option value="" disabled>'), studio.split("\n").some((line) => line.includes('id="batch-f"') && /\brequired>/.test(line))], [true, true]);
  is("the partial answer has its own message", /unrecorded: /.test(studio), true);

  part("The part not written down is shown in the file's own currency (Codex X6 on #3906, MEDIUM)");
  // A USD file confirmed after the store switched to JPY: $30.00, never ¥3,000.
  const realFetch = globalThis.fetch;
  const sent: unknown[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: "unrecorded", written: 1, held: 0, unrecorded: 1, unrecordedCents: 3_000 }), { status: 409 });
  }) as typeof fetch;
  try {
    const usd = await postBatch({ date: "2026-11-20", reference: "PayPal batch 9" }, { id: "f-usd", currency: "usd" });
    const message = "error" in usd ? usd.error : "";
    is("a USD file's part is said in dollars, not in the store's yen", [/\(\$30(\.00)?\)/.test(message), /¥/.test(message)], [true, false]);
    is("the request names the chosen file, with the date and reference typed", sent[0], { date: "2026-11-20", reference: "PayPal batch 9", file: "f-usd" });
    const jpy = await postBatch({ date: "2026-11-20", reference: "PayPal batch 9" }, { id: "f-jpy", currency: "jpy" });
    is("a JPY file's part is said in yen", "error" in jpy && /¥3,000/.test(jpy.error), true);
  } finally {
    globalThis.fetch = realFetch;
  }
  is("the studio confirms with the chosen file itself, never with the store's currency", [studio.includes("postBatch({ date: batchDate, reference: batchReference }, chosenFile)"), /postBatch\([^)]*\),\s*currency\)/.test(studio)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
