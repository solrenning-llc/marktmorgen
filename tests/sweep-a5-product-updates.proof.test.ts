/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/product-updates.ts advanceUpdate:
 *
 * (1) lines 294-301: the stop / list / suppression checks for a batch are read as
 *       Number(checks[i * 3]) !== 1 && !parseContact(checks[i * 3 + 1])?.unsub && !wasSuppressed(checks[i * 3 + 2])
 *     A pipeline reply cut short or of another shape makes every check "not stopped, not unsubscribed, not erased":
 *     the update email goes to a buyer who left the creator's list (or pressed stop, or was erased). Named by reading
 *     in claude5/sweep-a6 (docs/reviews/c5-sweep-a6.md F1); reproduced here.
 * (2) lines 286-291: an LRANGE of the recipients answered in an unknown shape is read as [] ("nothing left"): the job
 *     is set to done = total, status "sent", and its recipient list DELeted; nobody was written to and the studio
 *     says the update was sent.
 */
import { advanceUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { upsertContact, unsubscribe, tokensFor } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "owner@example.com";
type Message = { to: string | string[] };
let batches: Message[][] = [];
let sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)) as Message[];
      batches.push(batch);
      return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${batches.length}_${i}` })) });
    }
    return Response.json({ id: "email_1" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const paid = (id: string, email: string, product: string) => ({
  id, object: "checkout.session", status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 86_400,
  amount_total: 2700, currency: "usd", customer_details: { email }, metadata: { store: "harbor", product },
});
const original = redis.pipeline.bind(redis);
const sentTo = () => batches.flat().map((m) => [m.to].flat()[0]).sort();

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Jenny at Harbor", address: "1 Main St, Portland, OR 97201" });
  const ids: string[] = [];
  for (const title of ["Planner A", "Planner B", "Planner C"]) {
    const made = await addProduct(OWNER, title, "", "27", null);
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  sessions = ids.flatMap((id, k) => [paid(`cs_a${k}`, "ana@example.com", id), paid(`cs_b${k}`, "ben@example.com", id)]);
  const load = async () => (await storeForEmail(OWNER))!;
  // Ben left the creator's list.
  const store = await load();
  await upsertContact(store.listId as string, "ben@example.com", { agreed: true, explicit: true, source: "import" }, ROOM);
  const ben = (await tokensFor(store.listId as string, ["ben@example.com"], store.handle)).get("ben@example.com");
  if (ben) await unsubscribe(ben);
  const start = async (id: string) => {
    const r = await startUpdate(await load(), (await readListing(await load(), id))!, "New recipes.");
    if (!r.ok) throw new Error(`not started: ${r.reason}`);
    return r.job.id;
  };

  part("Healthy control: Ben left the list, so only Ana is written to");
  batches = [];
  const healthy = await advanceUpdate(await start(ids[0]), storeForHandle, Date.now() + 20_000);
  is("sent to Ana only", [healthy?.status, sentTo()], ["sent", ["ana@example.com"]]);

  part("DEFECT 1: the batch's stop/list/suppression checks answered short (no reply for any check)");
  batches = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 6 && commands[0][0] === "EXISTS" && String(commands[0][1]).length > 0 && commands[1][0] === "HGET") { await original(commands); return []; }
    return original(commands);
  }) as typeof redis.pipeline;
  const blind = await advanceUpdate(await start(ids[1]), storeForHandle, Date.now() + 20_000);
  redis.pipeline = original;
  is("DEFECT: Ben, who left the creator's list, is emailed too", [blind?.status, sentTo()], ["sent", ["ana@example.com", "ben@example.com"]]);

  part("DEFECT 2: the LRANGE of the recipients answered in an unknown shape");
  batches = [];
  const third = await start(ids[2]);
  is("control: the job's recipient list is there before the run", (await redis.pipeline([["LLEN", `nl:upd:job:${third}:to`]]))[0], 2);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0][0] === "LRANGE") return [{ unexpected: true }];
    return original(commands);
  }) as typeof redis.pipeline;
  const lost = await advanceUpdate(third, storeForHandle, Date.now() + 20_000);
  redis.pipeline = original;
  const kept = await readUpdateJob(third);
  is("DEFECT: nobody was written to", sentTo(), []);
  is("DEFECT: yet the job is 'sent', done = total = 2, sent = 0", [lost?.status, kept?.done, kept?.total, kept?.sent], ["sent", 2, 2, 0]);
  is("DEFECT: and its recipient list is deleted, so it can never go out", (await redis.pipeline([["EXISTS", `nl:upd:job:${third}:to`]]))[0], 0);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
