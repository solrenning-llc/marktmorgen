/**
 * Review proof (#2674): a store genuinely past GIVES_PER_DAY is answered
 * 503 "unavailable ... Try again in a moment" instead of 429 daily_limit,
 * the answer the developers page documents for the daily limit.
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { GIVES_PER_DAY } from "@/lib/api-write";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }))) as typeof fetch;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  // The day's gives already used (the counter is exact, at its limit).
  const key = `nl:rl:api-give:${createHash("sha256").update(`nimbus-api-give:${store.sid}`).digest("hex").slice(0, 32)}`;
  await redis.pipeline([["SET", key, String(GIVES_PER_DAY), "EX", 86_400]]);
  part("a real daily limit");
  const response = await postAccess(new Request("https://marktmorgen.com/api/v1/access", { method: "POST", headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "cy@example.com", product: guide.product.id }) }));
  const json = (await response.json()) as { error?: string };
  is("past the day's gives: 429 daily_limit, not 503 unavailable", [response.status, json.error], [429, "daily_limit"]);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
