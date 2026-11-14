/**
 * A waitlist launch the store's email meter would not take waits; it never passes people over and deletes the list
 * (Claude 3 cloud O's MEDIUM on #4473). The launch reads the month's figure before each batch, but the meter inside
 * sendBatch can still refuse for reasons that read does not see: a funded store whose window cannot be reserved
 * (meterCohortReady), or another email (a receipt, a reminder) taking the last of the room between the read and the
 * send. On "refused" the cursor moved past those people and the last batch deleted the waitlist. Now a refusal the
 * meter accounts for (the window not reserved, the room no longer there, or a read that cannot be made) keeps the
 * batch waiting, its cursor and its lists as they were. Synthetic Redis, Amazon and Resend; nothing is reached.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsedExact, giveAllowance, takeAllowance } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] };
const batches: Sent[][] = [];
const REGION = "us-east-1";
const amazon: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  // Amazon SES, the sender list and launch email goes through first (synthetic: an approved account, every email taken).
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    return Response.json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "ASIAEXAMPLEWAITLIST1", SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: "session-token-waitlist", Expiration: Math.floor(Date.now() / 1000) + 3_600 } } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") return Response.json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 100, SentLast24Hours: 0 } });
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } };
      amazon.push(body.Destination.ToAddresses[0]);
      return Response.json({ MessageId: `m-${amazon.length}` });
    }
    return Response.json({}, { status: 404 });
  }
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ADDRESS = "1 Main St, Portland, OR 97201";
const JOBS = "nl:wl:jobs";
type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
/** Runs once, the moment the launch reads its next batch (after its month read): another email taking the room. */
let onBatchRead: (() => Promise<void>) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const reads = commands.some((c) => c[0] === "LRANGE" && String(c[1]).endsWith(":send"));
  if (reads && onBatchRead) {
    const run = onBatchRead;
    onBatchRead = null;
    await run();
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

async function launched(owner: string, handle: string) {
  await claimHandle(owner, handle, "Wait Kitchen", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const added = await addProduct(owner, "The Wait Book", "", "39", null);
  if (!added.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, added.product.id))!;
  const sid = store.statsId!, pid = product.id;
  await setSoon(store, pid, true);
  for (const [i, email] of ["dana@example.com", "hal@example.com"].entries()) await redis.pipeline([["HSET", `nl:wl:${sid}:${pid}`, email, JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) })]]);
  const started = await launch(store, product, { note: "", address: ADDRESS });
  if (!started.ok) throw new Error("not launched");
  return { store, sid, pid };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  const sentTo = () => [...amazon, ...batches.flat().map((m) => [m.to].flat()[0])];
  const state = async (store: Awaited<ReturnType<typeof launched>>["store"], sid: string, pid: string) => {
    const view = (await waitlistViews(store, [pid]))[pid];
    return [(await redis.pipeline([["SISMEMBER", JOBS, `${sid}|${pid}`]]))[0], view.launch?.cursor, Boolean(view.launch?.finished), view.confirmed, (await redis.pipeline([["LLEN", `nl:wl:${sid}:${pid}:send`]]))[0]];
  };

  part("A funded window the meter cannot reserve: the launch waits, nobody passed over (cloud O's MEDIUM on #4473)");
  {
    const { store, sid, pid } = await launched("funded-owner@example.com", "fundedwait");
    const now = Math.floor(Date.now() / 1000);
    const funded = async (handle: string) => {
      const s = await storeForHandle(handle);
      return s ? { ...s, period: { start: now - 86_400, end: now + 20 * 86_400, funded: true } } : null;
    };
    const before = sentTo().length;
    const sent = await runLaunches(funded as typeof storeForHandle, readListing, Date.now() + 10_000);
    is("nothing sent", [sent, sentTo().length - before], [0, 0]);
    is("queued, cursor not moved, list and send list kept", await state(store, sid, pid), [1, 0, false, 2, 2]);
  }

  part("The month's room taken by another email between the launch's read and its send: the launch waits");
  {
    // On its own: the launch above, still queued, would go out in this run once the window is no longer funded.
    redis.clear();
    const { store, sid, pid } = await launched("race-owner@example.com", "racewait");
    onBatchRead = async () => {
      const used = (await allowanceUsedExact(store, "email")) ?? 0;
      await takeAllowance(store, "email", allowanceFor(store, "email") - used);
    };
    const before = sentTo().length;
    const sent = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
    is("nothing sent", [sent, sentTo().length - before], [0, 0]);
    is("queued, cursor not moved, list and send list kept", await state(store, sid, pid), [1, 0, false, 2, 2]);
    await giveAllowance(store, "email", (await allowanceUsedExact(store, "email")) ?? 0);
    const later = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
    is("once the room is back, both are emailed, each once", [later, sentTo().length - before], [2, 2]);
  }
  done();
}

void main();
