/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): SES accepts an email of a batch, then the
 * reply is lost (timeout / TypeError "fetch failed", or a 5xx after
 * acceptance). sendBatch reports "retry", documented as "nothing was sent and
 * the same batch may be tried again later". Every sendBatch caller
 * (product updates, community mail, waitlist, review requests...) then calls
 * again with the same batchKey. The second call must not write to the
 * recipient whose acceptance is unknown.
 */
import { sendBatch } from "@/lib/email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const REGION = "us-east-1";
const posted: string[] = [];
let loseReplyFor: string | null = null;
let lossKind: "throw" | 500 = "throw";

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 10, SentLast24Hours: 0 } });
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] } };
      const to = body.Destination.ToAddresses[0];
      posted.push(to); // SES took it.
      if (to === loseReplyFor) {
        if (lossKind === "throw") throw new TypeError("fetch failed");
        return json({ message: "internal" }, 500);
      }
      return json({ MessageId: `m-${posted.length}` });
    }
    return json({}, 404);
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const credentials = { AccessKeyId: "ASIAEXAMPLEPROBE0001", SecretAccessKey: "probe-secret-0000000000000000000000000000", SessionToken: "probe-token", Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  if (url.hostname === "api.resend.com") return json({ data: [] });
  return json({}, 404);
}) as typeof fetch;

const letter = (to: string) => ({ from: "Marktmorgen <hello@marktmorgen.com>", to, subject: "Update", text: "Hello.", html: "<p>Hello.</p>" });

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_probe_stand_in";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-probe";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";

  for (const kind of ["throw", 500] as const) {
    part(`SES reply lost (${kind}) after acceptance, then the caller retries the same batch`);
    posted.length = 0;
    lossKind = kind;
    loseReplyFor = "unknown@example.com";
    const key = `upd:probe-${kind}:0:3`;
    const batch = [letter("ok@example.com"), letter("unknown@example.com"), letter("later@example.com")];
    const first = await sendBatch(batch, key, { by: "company" });
    is(`${kind}: first call reports retry`, first, "retry");
    is(`${kind}: SES took unknown@ once in the first call`, posted.filter((t) => t === "unknown@example.com").length, 1);
    // The provider recovers; the caller (e.g. lib/product-updates.ts) runs again
    // with the same key, exactly as its "retry" branch does.
    loseReplyFor = null;
    await sendBatch(batch, key, { by: "company" });
    is(`${kind}: unknown@ is never written to twice`, posted.filter((t) => t === "unknown@example.com").length, 1);
    is(`${kind}: the rest of the batch is not stuck behind it`, posted.filter((t) => t === "later@example.com").length, 1);
    is(`${kind}: the confirmed one is not written to again`, posted.filter((t) => t === "ok@example.com").length, 1);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
