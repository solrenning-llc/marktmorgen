/**
 * j-mail-6 (Claude 3 cloud J, email audit): an import emails the people it brought over a portion at a time, read
 * with SRANDMEMBER (lib/imports.ts mailStep). A portion whose sending was not confirmed (the sender may have taken
 * some of it, then an answer was lost) goes back to be tried again. It must be tried again as the same portion under
 * the same key, so whoever Amazon already took is not written to twice (lib/ses.ts notYetTaken, keyed by the batch).
 * The key was the lowest address and the count of a portion drawn at random, so the retry drew another portion
 * under another key, and those Amazon had taken were emailed again. Synthetic only.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addRows, finishUpload, runImport, startImport } from "@/lib/imports";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const REGION = "us-east-1";
const amazon: string[] = [];
/** Amazon loses its answer to the post with this number (1-based), once: that email may have been taken. */
let losesReplyAt = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    return answer({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "ASIAEXAMPLEIMPORT001", SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: "session-token-import", Expiration: Math.floor(Date.now() / 1000) + 3_600 } } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") return answer({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 200, SentLast24Hours: 0 } });
    if (url.pathname === "/v2/email/outbound-emails") {
      const to = (JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } }).Destination.ToAddresses[0];
      amazon.push(to);
      if (amazon.length === losesReplyAt) {
        throw new TypeError("synthetic response lost after SES acceptance");
      }
      return answer({ MessageId: `m-${amazon.length}` });
    }
    return answer({}, 404);
  }
  if (url.hostname === "api.resend.com") throw new Error("this test sends through Amazon only");
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  Object.assign(process.env, {
    AWS_SES_REGION: REGION, AWS_SES_CONFIGURATION_SET: "marktmorgen", AWS_SES_TOPIC_ARN: `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`,
    AWS_SES_ROLE_ARN: "arn:aws:iam::123456789012:role/synthetic-baseline", VERCEL_OIDC_TOKEN: "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl",
  });
  redis.clear();
  const OWNER = "import-key-owner@example.com";
  await claimHandle(OWNER, "importkey", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestImpKey01", true);
  await setSubscription(OWNER, { customerId: "cus_importkey", subscriptionId: "sub_importkey", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");

  part("More members than one portion; Amazon loses one answer in the first");
  const renews = new Date((Math.floor(Date.now() / 1000) + 10 * DAY) * 1000).toISOString().slice(0, 10);
  const rows = Array.from({ length: 150 }, (_, i) => [String(i + 2), `member${i + 1}@example.com`, "The Inner Circle", renews, ""]);
  const started = await startImport((await storeForEmail(OWNER))!, OWNER, "members", { expected: rows.length, file: "patrons.csv", stopped: true });
  if (!started.ok) throw new Error(`not started: ${JSON.stringify(started)}`);
  const s = (await storeForEmail(OWNER))!;
  await addRows(s, started.job.id, rows);
  await finishUpload(s, started.job.id);
  // In the first portion, Amazon loses its answer to the 60th email: the others in that portion were taken.
  losesReplyAt = 60;
  let job = await runImport(started.job.id, Date.now() + 30_000);
  for (let i = 0; i < 30 && job && job.state !== "done"; i += 1) job = await runImport(started.job.id, Date.now() + 30_000);
  const times = new Map<string, number>();
  for (const to of amazon) times.set(to, (times.get(to) ?? 0) + 1);
  const twice = [...times].filter(([, n]) => n > 1).map(([to]) => to);
  is("every member was written to", times.size, 150);
  is("nobody Amazon took is written to twice (only the one whose answer was lost may be asked again)", twice.length <= 1, true);
  done();
}
void main();
