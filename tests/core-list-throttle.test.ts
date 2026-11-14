/**
 * Regression: a list batch that Amazon SES definitively did NOT take,
 * because it was throttled (429 TooManyRequests, "Maximum sending rate exceeded"),
 * must wait for SES (owner rule: never discarded). Today sendListBatch answers
 * "retry", which lib/mail.ts sendTo reads as possibly sent (`uncertain`), and
 * lib/broadcasts.ts then marks the whole broadcast "failed" with automatic
 * retries stopped: the rest of the list is never sent.
 *
 * Synthetic only: mocked fetch for STS and SES, in-memory Redis stub.
 */
import { sendListBatch } from "@/lib/email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const REGION = "us-east-1";
const outbound: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: {
      AccessKeyId: "ASIASYNTHETICONLY0001", SecretAccessKey: "synthetic-secret-for-tests-only-000000", SessionToken: "synthetic-session", Expiration: Math.floor(Date.now() / 1000) + 3_600,
    } } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      outbound.push(JSON.parse(String(init?.body)).Destination.ToAddresses[0]);
      // A definitive, transient refusal: nothing was accepted.
      return json({ message: "Maximum sending rate exceeded." }, 429, { "x-amzn-errortype": "TooManyRequestsException" });
    }
  }
  if (url.hostname === "api.resend.com") throw new Error("list mail must never reach Resend");
  return json({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_floor_only_a_stand_in";
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";

  part("SES throttles a list batch: nothing accepted, so it must wait, not be held as uncertain");
  const letter = { from: "Creator <c@marktmorgen.com>", to: "reader@example.com", subject: "News", text: "Hi.", html: "<p>Hi.</p>" };
  const outcome = await sendListBatch([letter], "list:throttle", { by: "monthly" });
  is("SES was asked and refused every attempt with 429 (no acceptance)", outbound.length >= 1, true);
  is("a definitive throttle with nothing taken is 'waiting' (retried later), not 'retry' (possibly sent, broadcast failed)", outcome, "waiting");
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
