/** Exact Redis and cache evidence for creator email revenue and visit reports. */
import {
  keptMailRevenueBytes,
  readMailRevenuePaid,
  readMailVisits,
  type MailRevenue,
} from "@/lib/mail-revenue";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

type Pipeline = typeof redis.pipeline;

const creator = {
  stripeAccountId: "synthetic-mail-revenue-evidence",
  statsId: "stats_MailRevenueEvidence",
  currency: "usd",
} as Store;

const report: MailRevenue = {
  by: { "broadcast:mail-evidence": { sales: 2, cents: 3_400, elsewhere: 1 } },
  partial: true,
};

async function withReply<T>(reply: unknown[], read: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async () => reply) as Pipeline;
  try {
    return await read();
  } finally {
    redis.pipeline = original;
  }
}

async function withReplies<T>(replies: unknown[][], read: () => Promise<T>): Promise<{ value: T; calls: number }> {
  const original = redis.pipeline;
  let calls = 0;
  redis.pipeline = (async () => replies[calls++] ?? []) as Pipeline;
  try {
    return { value: await read(), calls };
  } finally {
    redis.pipeline = original;
  }
}

async function paid(reply: unknown[]): Promise<{ value: Awaited<ReturnType<typeof readMailRevenuePaid>>; before: number }> {
  let before = 0;
  const value = await withReply(reply, () => readMailRevenuePaid(creator, async () => {
    before += 1;
    return false;
  }));
  return { value, before };
}

async function main(): Promise<void> {
  part("The paid size is known only from one exact STRLEN reply");
  is("one non-negative integer is the exact byte count", await withReply([42], () => keptMailRevenueBytes(creator)), 42);
  is("an extra reply is unknown, not the first apparent byte count", await withReply([42, 7], () => keptMailRevenueBytes(creator)), null);
  is("text that merely looks numeric is not a STRLEN integer", await withReply(["42"], () => keptMailRevenueBytes(creator)), null);

  part("Unknown GET evidence never becomes a confirmed cache miss");
  is("an empty pipeline reply stops before asking permission for Stripe", await paid([]), { value: null, before: 0 });
  is("an extra pipeline reply stops before asking permission for Stripe", await paid([null, "extra"]), { value: null, before: 0 });
  is("a non-text, non-null reply stops before asking permission for Stripe", await paid([7]), { value: null, before: 0 });
  is("one confirmed null remains a legitimate cache miss", await paid([null]), { value: "refused", before: 1 });

  part("A cached revenue report has exact semantic evidence");
  const encoded = JSON.stringify(report);
  is("one valid cached report is returned", (await paid([encoded])).value, report);
  is("a valid-looking first slot plus an extra slot is unknown", await paid([encoded, null]), { value: null, before: 0 });
  for (const [label, invalid] of [
    ["partial is not boolean", { ...report, partial: 1 }],
    ["sales is negative", { by: { campaign: { sales: -1, cents: 0 } }, partial: false }],
    ["money is fractional", { by: { campaign: { sales: 1, cents: 0.5 } }, partial: false }],
    ["elsewhere is not an integer", { by: { campaign: { sales: 1, cents: 0, elsewhere: "1" } }, partial: false }],
    ["a row has an unknown field", { by: { campaign: { sales: 1, cents: 0, total: 1 } }, partial: false }],
  ] as const) {
    is(label, await paid([JSON.stringify(invalid)]), { value: null, before: 0 });
  }

  part("A cached visit count is exact, non-negative and integral");
  const broadcast = "broadcast_MailRevenueEvidence";
  is("one valid visit cache is returned", await withReply([JSON.stringify({ [broadcast]: 9 })], () => readMailVisits(creator, [broadcast])), { [broadcast]: 9 });
  is("an extra pipeline slot makes the visit cache unknown", await withReply([JSON.stringify({ [broadcast]: 9 }), null], () => readMailVisits(creator, [broadcast])), null);
  for (const [label, value] of [["negative", -1], ["fractional", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1]] as const) {
    is(`${label} cached visits are unknown, never shown as a count`, await withReply([JSON.stringify({ [broadcast]: value })], () => readMailVisits(creator, [broadcast])), null);
  }
  const cached = "a1";
  const newer = "b2";
  const fresh = Array.from({ length: 90 }, (_, day) => day === 89 ? [5, 0, 0, 7, 0, 0] : [0, 0, 0, 0, 0, 0]);
  is(
    "a valid cache missing a newer email is read afresh rather than hiding every count",
    await withReplies([[JSON.stringify({ [cached]: 3 })], fresh, ["OK"]], () => readMailVisits(creator, [cached, newer])),
    { value: { [cached]: 5, [newer]: 7 }, calls: 3 },
  );

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
