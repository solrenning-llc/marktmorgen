/**
 * Why a members import leaves a row out when its membership cannot be sold
 * now (found end to end on 11/11/2026, checking #3384 in the app: a published
 * membership with nothing to hand over was reported "Not on sale in your
 * store now: publish it first", advice that does not fix it). Each reason
 * that canSellProduct can have for a membership the import reaches says its
 * own fix: a draft is published, a membership with nothing to hand over gets
 * what members receive. (A store that is not selling never starts a members
 * import, so that reason never reaches a row.) Synthetic only: Redis is
 * lib/redis-memory.ts, Stripe and the sender are stand-ins for fetch.
 */
import { addProduct, claimHandle, ensureStatsId, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, reportCsv, runImport, startImport } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

async function membersReport(owner: string, club: string): Promise<string> {
  const day = new Date((Math.floor(Date.now() / 1000) + 20 * 86_400) * 1000).toISOString().slice(0, 10);
  const rows = [["2", "mia@example.com", club, day, ""]];
  const started = await startImport((await storeForEmail(owner))!, owner, "members", { expected: rows.length, file: "members.csv", stopped: true });
  if (!started.ok) throw new Error(`the import did not start: ${JSON.stringify(started)}`);
  const s = (await storeForEmail(owner))!;
  await addRows(s, started.job.id, rows);
  await finishUpload(s, started.job.id);
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let i = 0; i < 20 && job && job.state !== "done"; i += 1) job = await runImport(started.job.id, Date.now() + 30_000);
  if (!job) throw new Error("the import was not found");
  return reportCsv(job);
}

async function store(owner: string, handle: string) {
  await claimHandle(owner, handle, "Harbor Kitchen", "");
  await ensureStatsId(owner);
  {
    await setStripeAccount(owner, `acct_1Test${handle.slice(0, 6).padEnd(6, "0")}01`, true);
    await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, period: paidPeriod() });
  }
  const club = await addProduct(owner, "Kitchen Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  return club.product.id;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();

  part("A published membership with nothing to hand over");
  const A = "why-a@example.com";
  await store(A, "whyhandover");
  const nothing = await membersReport(A, "Kitchen Club");
  is("never told to publish what is already published", nothing.includes("publish it first"), false);
  is("told what to add", nothing.includes("Nothing to hand over yet: add what members get"), true);

  part("A draft membership");
  const B = "why-b@example.com";
  const draft = await store(B, "whydraft");
  await setProductLink(B, draft, "https://example.com/club");
  await setProductHidden(B, draft, true);
  const hidden = await membersReport(B, "Kitchen Club");
  is("a draft is still told to publish it", hidden.includes("Not on sale in your store now: publish it first"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
