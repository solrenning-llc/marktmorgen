/**
 * A waitlist launch whose batch the store's email meter refused for a cause it could not prove waits, even when a read
 * of the month right after still finds room (Codex P's HIGH on #4473). The meter's own count of the batch had its
 * increment committed and its reply lost (a malformed answer), so it answered "unknown" and sendBatch said "refused".
 * The launch then asked the month again, found room, took the refusal for the sender's own, moved the cursor past those
 * people and, at the end, deleted the waitlist with nobody emailed. The cause of the refusal now comes back with it
 * (lib/email.ts, BatchRefusal): a refusal by the meter keeps the cursor and both lists for the next run. Synthetic Redis,
 * Amazon and Resend; nothing is reached.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { allowanceUsedExact } from "@/lib/store-allowance";
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
/** How many of the email meter's counts of a launch batch (an INCRBY of 2) come back malformed after they are made. */
let lostCounts = 0;
let countsLost = 0;
redis.pipeline = (async (commands: Command[]) => {
  const counts = commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:email:") && Number(c[2]) === 2);
  const reply = await pipeline(commands);
  if (counts && lostCounts > 0) {
    lostCounts--;
    countsLost++;
    // The increment is made; its answer is lost on the way back: not a count the meter can read.
    return [null] as unknown as typeof reply;
  }
  return reply;
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

  part("The meter's count of the batch made, its answer lost: the launch waits though the month still has room (Codex P's HIGH on #4473)");
  const { store, sid, pid } = await launched("lost-count@example.com", "lostcount");
  lostCounts = 1;
  const sent = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  is("the meter's answer was lost once", countsLost, 1);
  is("nothing sent, nothing handed to a sender", [sent, sentTo().length], [0, 0]);
  is("queued, cursor not moved, list and send list kept", await state(store, sid, pid), [1, 0, false, 2, 2]);
  is("the month still had room after the lost count (the read that used to decide)", ((await allowanceUsedExact(store, "email")) ?? -1) >= 2, true);

  part("The next run, with the meter answering: both are emailed, each once, and the launch finishes");
  const later = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  is("both emailed, each once", [later, sentTo().length, new Set(sentTo()).size], [2, 2, 2]);
  is("finished: off the queue, the lists gone", await state(store, sid, pid), [0, 2, true, 0, 0]);
  done();
}

void main();
