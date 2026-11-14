/**
 * Outage drill (Claude 7, 14 November 2026; synthetic only): a plain batch counted against a store's own email figure
 * (community event notices, waitlist launches) takes that figure before Amazon is asked (lib/email.ts, dispatchBatch).
 * When the batch then answers "retry" with nothing handed to Amazon (who was already taken could not be read, Amazon's
 * room was unknown, the possibly-taken marks could not be written), what it took is given back: a list sender keeps
 * trying such a batch each run (c38284f6), and an outage must never spend the store's emails on mail that never went.
 */
import { sendBatch } from "@/lib/email";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const letter = (to: string) => ({ from: "Harbor <hello@marktmorgen.com>", to, subject: "Event", text: "Hello.", html: "<p>Hello.</p>" });

async function main(): Promise<void> {
  redis.clear();
  const owner = "harbor-owner@example.com";
  await claimHandle(owner, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Harbor00001", subscriptionId: "sub_Harbor00001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  process.env.RESEND_API_KEY = "re_test_store_meter_only";
  const mail = installSesMailFixture();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  const meter = { by: "store" as const, store, kind: "email" as const };
  const batch = [letter("ana@example.com"), letter("ben@example.com")];

  const used = async () => allowanceUsedExact(store, "email");
  const start = await used();
  is("the store's email figure reads", typeof start, "number");

  part("Who was already taken cannot be read: retry, nothing sent, nothing kept taken");
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:ses:did:"))) throw new Error("Redis request timed out");
    return pipeline(commands);
  }) as typeof redis.pipeline;
  for (let run = 0; run < 5; run += 1) is(`run ${run + 1}: retry`, await sendBatch(batch, "cmev:drill:0:2", meter), "retry");
  redis.pipeline = pipeline;
  is("nothing was handed to Amazon", mail.sesAttempts.length, 0);
  is("five runs of the outage leave the store's emails as they were", await used(), start);

  part("Once Redis answers, the batch goes and is counted once");
  is("sent", await sendBatch(batch, "cmev:drill:0:2", meter), "sent");
  is("both emails went", mail.sesAttempts.length, 2);
  is("the figure counts the two that went", await used(), (start as number) + 2);
  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
