/**
 * j-mail-4 (Claude 3 cloud J, email audit): a waitlist launch emails each confirmed person once, from the store's
 * own email figure (lib/waitlist.ts runLaunches). When the month's figure cannot take the next batch, or cannot be
 * read, the people in it must wait for the next run (the month turning, or the read coming back), never be passed
 * over: the batch came back "refused" from the meter inside sendBatch, the cursor moved past them, and the launch
 * finished and deleted the list, so they never got the one email they confirmed for.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { giveAllowance, takeAllowance } from "@/lib/store-allowance";
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
const OWNER = "month-owner@example.com";
const JOBS = "nl:wl:jobs";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  await claimHandle(OWNER, "monthfull", "Month Full Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const added = await addProduct(OWNER, "The Month Book", "", "39", null);
  if (!added.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, added.product.id))!;
  const people = ["dana@example.com", "hal@example.com"];
  const sid = store.statsId!, pid = product.id;
  const list = `nl:wl:${sid}:${pid}`;
  await setSoon(store, pid, true);
  for (const [i, email] of people.entries()) await redis.pipeline([["HSET", list, email, JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48) })]]);
  const started = await launch(store, product, { note: "", address: ADDRESS });
  is("launched for both", started.ok && started.total, 2);

  part("The month's figure has room for one, and the batch is two");
  const figure = allowanceFor(store, "email");
  is("the store has a figure to use (synthetic)", figure >= 2, true);
  const used = await takeAllowance(store, "email", figure - 1);
  is("all but one of the month used", used.ok, true);
  const first = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  const view = (await waitlistViews(store, [pid]))[pid];
  is("nobody emailed", [first, batches.flat().length, amazon.length], [0, 0, 0]);
  is("the launch stays queued at the start, its list kept", [(await redis.pipeline([["SISMEMBER", JOBS, `${sid}|${pid}`]]))[0], view.launch?.cursor, Boolean(view.launch?.finished), view.confirmed], [1, 0, false, 2]);

  part("The month turns (its figure free again): both are emailed, once");
  await giveAllowance(store, "email", figure - 1);
  const second = await runLaunches(storeForHandle, readListing, Date.now() + 10_000);
  is("both emailed once", [second, [...amazon, ...batches.flat().map((m) => [m.to].flat()[0])].sort()], [2, people.slice().sort()]);
  done();
}
void main();
