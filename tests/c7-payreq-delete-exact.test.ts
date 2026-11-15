/**
 * Issue #4775 (Codex P, reproduced by Claude 2): deleting a payment request answered "deleted" without reading the five
 * removals of its record and indexes. Synthetic store, the Redis stub.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readDraft } from "@/lib/payment-request-rules";
import { cancelRequest, createRequest, deleteRequest, requestRecordKey } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_zz_4b_request_delete";
  const owner = "zz4b-owner@example.com";
  await claimHandle(owner, "zz4bshop", "ZZ 4B Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Reqzz4bshop", true);
  await setSubscription(owner, { customerId: "cus_zz4bshop", subscriptionId: "sub_zz4bshop", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const now = Date.now();
  const draft = (readDraft({ email: "client@example.com", name: "Dana", lines: [{ text: "Coaching", quantity: 1, amount: "480" }], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", now) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;
  const made = await createRequest(store, draft, now);
  if (!made.ok) throw new Error("no request: " + JSON.stringify(made));
  is("canceled", await cancelRequest(store, made.request.id, now) !== null, true);

  part("A delete whose pipeline reply is cut short");
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 5 && commands[0][0] === "DEL" && commands[0][1] === requestRecordKey(made.request.id)) return [];
    return real(commands);
  }) as typeof redis.pipeline;
  let answer = "";
  try { answer = String(await deleteRequest(store, made.request.id, now)); } catch { answer = "threw"; } finally { redis.pipeline = real; }
  is("an unconfirmed delete is not reported as deleted", answer === "deleted", false);
  is("the record is still stored", typeof redis.run(["GET", requestRecordKey(made.request.id)]), "string");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
