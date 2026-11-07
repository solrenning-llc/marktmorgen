/**
 * A payout the creator writes down ("Mark as paid", or a payout file confirmed) is said as written only on the exact
 * answer of a new field written (CX-123 rule 24). Synthetic only: the in-memory Redis double, the real
 * lib/affiliates.ts, lib/affiliate-payouts.ts and the real route app/api/store/affiliates/route.ts.
 *
 * (MEDIUM, money) addPayout used to send its HSET and return the payout whatever Redis answered. A reply missing or
 * of another shape, with nothing written, was reported as "recorded": the book still owed the affiliate the same
 * amount, so the next payout file, or the PayPal payment on payday (readBook), paid it a second time. HSET answering
 * 0 means the field already existed and was overwritten, which loses the payout that was there: never "written".
 * Now each of these throws UnknownReplyError: the route answers 503 "unavailable", the batch says it failed, and the
 * creator's retry reads the book again, so nothing is written down twice.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addPayout } from "@/lib/affiliates";
import { recordBatch } from "@/lib/affiliate-payouts";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** What the payouts hash's HSET answers instead of Redis, with nothing written; undefined: Redis itself. */
let payoutReply: { reply: unknown } | undefined;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (payoutReply && one?.[0] === "HSET" && /^nl:aff:[^:]+:payouts$/.test(String(one[1]))) return [payoutReply.reply];
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "payer@example.com";
  await claimHandle(owner, "payershop", "Payer store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1payershop830", true);
  await setSubscription(owner, { customerId: "cus_payer", subscriptionId: "sub_payer", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId as string;
  const A = "aaaaaaaaaaaa";
  await real([["HSET", `nl:aff:${statsId}:people`, A, JSON.stringify({ id: A, email: "aff@example.com", code: "caff", status: "approved", appliedAt: 1, decidedAt: 1, note: "", rate: null, paypal: "", share: null, cleared: null, by: null })]]);
  const payouts = async () => ((await real([["HLEN", `nl:aff:${statsId}:payouts`]]))[0] as number);
  const input = { aff: A, cents: 3000, currency: store.currency, date: "2026-11-01", reference: "Bank transfer" };

  part("addPayout: written only on HSET's exact 1");
  for (const [label, reply] of [
    ["no reply", undefined],
    ["null", null],
    ["a string", "1"],
    ["0 (an existing payout overwritten)", 0],
    ["a list", [1]],
  ] as const) {
    payoutReply = { reply };
    const got = await addPayout(store, input).then(
      (payout) => (payout ? "written" : "refused"),
      (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
    );
    is(`an HSET answered ${label} is not known, never "written"`, got, "unknown");
  }
  payoutReply = undefined;
  is("(nothing was written by those)", await payouts(), 0);
  const written = await addPayout(store, input);
  is("an HSET answered exactly 1 is written", written?.cents, 3000);
  is("(and is in the book)", await payouts(), 1);

  part('"Mark as paid": an unknown write answers 503, never ok');
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  payoutReply = { reply: null };
  const response = await affiliatesRoute(
    new NextRequest("https://marktmorgen.com/api/store/affiliates", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ action: "payout", id: A, amount: "30", date: "2026-11-02", reference: "Bank transfer" }),
    }),
  );
  const body = (await response.json()) as { ok?: boolean; error?: string };
  is("the route does not say it was recorded", body.ok, false);
  is("it answers 503 unavailable", [response.status, body.error], [503, "unavailable"]);
  payoutReply = undefined;
  is("(the book holds only the one written)", await payouts(), 1);

  part("A payout file confirmed: an unknown write is never counted as written");
  const book = {
    rows: [{ affiliate: { id: A, email: "aff@example.com", paypal: "", status: "approved" }, payable: 2500, owed: 2500, held: 0, flags: [] }],
    lines: [],
    payouts: [],
    refundsChecked: true,
    invoicesChecked: true,
    currency: store.currency,
    elsewhere: 0,
  } as unknown as Parameters<typeof recordBatch>[1];
  payoutReply = { reply: null };
  const batch = await recordBatch(store, book, { date: "2026-11-03", reference: "Batch" }).then(
    (r) => `written ${r.written}`,
    (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`),
  );
  payoutReply = undefined;
  is("the batch does not count a line whose write is not known", batch, "unknown");
  is("(the book holds only the one written)", await payouts(), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
