import { done, is, part } from "./check";
import { withCutoff } from "@/lib/fetch-timeout";

const oldFetch = globalThis.fetch;
const names = [
  "AWS_SES_ROLE_ARN", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET",
  "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN",
] as const;
for (const name of names) delete process.env[name];

async function main(): Promise<void> {
  const { sesProviderUsage } = await import("@/lib/ses-provider-usage");

  part("Configuration and timestamps fail closed before I/O");
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return new Response(); };
  is("missing configuration is not zero", await sesProviderUsage(1_000), { ok: false, reason: "not_configured" });
  is("an invalid snapshot is unknown", await sesProviderUsage(Number.NaN), { ok: false, reason: "unknown" });
  is("safe integers outside JavaScript Date range are unknown", await sesProviderUsage(Number.MAX_SAFE_INTEGER), { ok: false, reason: "unknown" });
  is("neither case reaches a provider", requests, 0);

  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-provider-usage";
  process.env.AWS_SES_REGION = "us-east-1";
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:marktmorgen-email";
  process.env.VERCEL_OIDC_TOKEN = "header.payload.signature";

  part("The official rolling counter is observed within a latency interval");
  const accountRequests: { method: string; authorization: string; token: string; cache: RequestCache | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "sts.us-east-1.amazonaws.com") {
      return Response.json({
        AssumeRoleWithWebIdentityResponse: {
          AssumeRoleWithWebIdentityResult: {
            Credentials: {
              AccessKeyId: "ASIASYNTHETICUSAGE01",
              SecretAccessKey: "synthetic-secret-provider-usage-only",
              SessionToken: "synthetic-provider-usage-session",
              Expiration: 4_000_000_000,
            },
          },
        },
      });
    }
    accountRequests.push({
      method: String(init?.method),
      authorization: String(new Headers(init?.headers).get("authorization")),
      token: String(new Headers(init?.headers).get("x-amz-security-token")),
      cache: init?.cache,
    });
    return Response.json({
      ProductionAccessEnabled: true,
      SendingEnabled: true,
      EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 37 },
    });
  };
  is("SES count and readiness retain both bounding instants without claiming a shared snapshot",
    await sesProviderUsage(1_000, () => 1_125),
    {
      ok: true,
      sentLast24Hours: 37,
      max24: 50_000,
      rate: 14,
      production: true,
      sending: true,
      enforcement: "HEALTHY",
      requestedAt: "1970-01-01T00:00:01.000Z",
      observedAt: "1970-01-01T00:00:01.125Z",
    });
  is("a backwards response clock is unknown",
    await sesProviderUsage(2_000, () => 1_999),
    { ok: false, reason: "unknown" });
  is("an impossible response clock is unknown", await sesProviderUsage(2_000, () => Number.MAX_SAFE_INTEGER), { ok: false, reason: "unknown" });
  const firstAccountRequest = accountRequests[0];
  is("the read is signed with only the temporary role identity and is not cached",
    [
      firstAccountRequest?.method,
      firstAccountRequest?.authorization.startsWith("AWS4-HMAC-SHA256 Credential=ASIASYNTHETICUSAGE01/"),
      firstAccountRequest?.token,
      firstAccountRequest?.cache,
    ],
    ["GET", true, "synthetic-provider-usage-session", "no-store"]);

  part("Malformed, unauthorized and unavailable evidence never becomes zero");
  let getterCalls = 0;
  const getterQuota = Object.defineProperty({}, "SentLast24Hours", {
    get() { getterCalls += 1; return 0; },
  });
  for (const account of [
    {},
    {
      ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY",
      SendQuota: getterQuota,
    },
    {
      ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: -1 },
    },
    {
      ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "UNKNOWN",
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 0 },
    },
  ]) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => account }) as Response;
    is("partial or executable account usage is unknown", await sesProviderUsage(2_000), { ok: false, reason: "unknown" });
  }
  is("provider getters were not executed", getterCalls, 0);
  globalThis.fetch = async () => new Response("", { status: 403 });
  is("authorization failure stays distinct", await sesProviderUsage(2_000), { ok: false, reason: "unauthorized" });
  globalThis.fetch = async () => new Response("", { status: 503 });
  is("provider refusal is not absence", await sesProviderUsage(2_000), { ok: false, reason: "provider" });
  globalThis.fetch = async () => { throw new Error("synthetic network loss"); };
  is("transport loss is not absence", await sesProviderUsage(2_000), { ok: false, reason: "provider" });

  part("Known quota edges stay distinct from malformed evidence");
  globalThis.fetch = async () => Response.json({
    ProductionAccessEnabled: false, SendingEnabled: false, EnforcementStatus: "SHUTDOWN",
    SendQuota: { Max24HourSend: -1, MaxSendRate: 1.5, SentLast24Hours: Number.MAX_SAFE_INTEGER },
  });
  is("the documented unlimited quota preserves its sentinel and an exact safe counter",
    await sesProviderUsage(2_000, () => 2_001), {
      ok: true, sentLast24Hours: Number.MAX_SAFE_INTEGER, max24: -1, rate: 1.5,
      production: false, sending: false, enforcement: "SHUTDOWN",
      requestedAt: "1970-01-01T00:00:02.000Z", observedAt: "1970-01-01T00:00:02.001Z",
    });
  for (const SendQuota of [
    { Max24HourSend: 0, MaxSendRate: 14, SentLast24Hours: 0 },
    { Max24HourSend: 50_000, MaxSendRate: 0, SentLast24Hours: 0 },
    { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: Number.MAX_SAFE_INTEGER + 1 },
    { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 1.5 },
  ]) {
    globalThis.fetch = async () => Response.json({
      ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota,
    });
    is("invalid quotas do not turn into zero", await sesProviderUsage(2_000), { ok: false, reason: "unknown" });
  }
  const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("synthetic trap"); } });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => throwingProxy }) as Response;
  is("executable object traps are unknown", await sesProviderUsage(2_000), { ok: false, reason: "unknown" });
  globalThis.fetch = async () => new Response("{broken");
  is("invalid JSON is unknown", await sesProviderUsage(2_000), { ok: false, reason: "unknown" });

  part("The deadline includes a body that never finishes");
  let bodySignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    bodySignal = init?.signal as AbortSignal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
  };
  is("a stalled SES body fails at the caller cutoff",
    await withCutoff(Date.now() + 250, () => sesProviderUsage(2_000)),
    { ok: false, reason: "provider" });
  is("the SES request is aborted while reading its body", (bodySignal as AbortSignal | null)?.aborted, true);

  globalThis.fetch = oldFetch;
  done();
}

main().catch((error) => {
  globalThis.fetch = oldFetch;
  console.error(error);
  process.exit(1);
});
