import { createHash } from "node:crypto";
import { store } from "./redis-stub";

export type SesFixtureOutcome = "ok" | "lost" | "server-error" | "refused" | "account";

export type CapturedMail = {
  provider: "ses" | "resend";
  batch: boolean;
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
};

type FetchInput = string | URL | Request;
type FetchFallback = (input: FetchInput, init?: RequestInit) => Response | Promise<Response>;

export type SesMailFixtureOptions = {
  fallback?: FetchFallback;
  onSes?: (message: CapturedMail, input: FetchInput, init?: RequestInit) => Response | Promise<Response> | undefined;
  onResend?: (
    messages: CapturedMail[],
    input: FetchInput,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined;
};

const ENV_KEYS = [
  "AWS_SES_ROLE_ARN",
  "AWS_SES_REGION",
  "AWS_SES_CONFIGURATION_SET",
  "AWS_SES_TOPIC_ARN",
  "VERCEL_OIDC_TOKEN",
] as const;
const STATE_KEY = "nl:ses:state";

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" ? [value] : [];

function normalizedHeaders(value: unknown): Record<string, string> | undefined {
  if (Array.isArray(value)) {
    const entries = value.flatMap((raw): [string, string][] => {
      const item = record(raw);
      const name = text(item.Name ?? item.name);
      return name ? [[name, text(item.Value ?? item.value)]] : [];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  const entries = Object.entries(record(value)).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizedTags(value: unknown): { name: string; value: string }[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.flatMap((raw): { name: string; value: string }[] => {
      const item = record(raw);
      const name = text(item.Name ?? item.name);
      return name ? [{ name, value: text(item.Value ?? item.value) }] : [];
    });
    return tags.length ? tags : undefined;
  }
  const tags = Object.entries(record(value)).flatMap(([name, raw]) =>
    typeof raw === "string" ? [{ name, value: raw }] : [],
  );
  return tags.length ? tags : undefined;
}

function normalizeSes(raw: unknown): CapturedMail {
  const payload = record(raw);
  const simple = record(record(payload.Content).Simple);
  const body = record(simple.Body);
  const rich = text(record(body.Html).Data);
  const replyTo = stringArray(payload.ReplyToAddresses)[0];
  const headers = normalizedHeaders(simple.Headers);
  const tags = normalizedTags(payload.EmailTags);
  return {
    provider: "ses",
    batch: false,
    from: text(payload.FromEmailAddress),
    to: stringArray(record(payload.Destination).ToAddresses),
    subject: text(record(simple.Subject).Data),
    text: text(record(body.Text).Data),
    html: rich,
    ...(replyTo ? { replyTo } : {}),
    ...(headers ? { headers } : {}),
    ...(tags ? { tags } : {}),
  };
}

function normalizeResend(raw: unknown, batch: boolean): CapturedMail {
  const payload = record(raw);
  const html = text(payload.html);
  const replyTo = text(payload.reply_to);
  const headers = normalizedHeaders(payload.headers);
  const tags = normalizedTags(payload.tags);
  return {
    provider: "resend",
    batch,
    from: text(payload.from),
    to: stringArray(payload.to),
    subject: text(payload.subject),
    text: text(payload.text),
    html,
    ...(replyTo ? { replyTo } : {}),
    ...(headers ? { headers } : {}),
    ...(tags ? { tags } : {}),
  };
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

export function installSesMailFixture(options: SesMailFixtureOptions = {}) {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = Object.fromEntries(
    ENV_KEYS.map((name) => [name, process.env[name]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
  const attempts: CapturedMail[] = [];
  const sent: CapturedMail[] = [];
  const sesAttempts: CapturedMail[] = [];
  const resendAttempts: CapturedMail[] = [];
  const ses: CapturedMail[] = [];
  const resend: CapturedMail[] = [];
  const calls = { sts: 0, account: 0, ses: 0, resend: 0 };
  let ready = true;
  let max24 = 50_000;
  let rate = 100;
  let defaultOutcome: SesFixtureOutcome = "ok";
  let queuedOutcomes: SesFixtureOutcome[] = [];
  const invalidateState = () => { store.run(["DEL", STATE_KEY]); };

  const configure = () => {
    process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/MarktmorgenSesFixture";
    process.env.AWS_SES_REGION = "us-east-1";
    process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen-fixture";
    process.env.AWS_SES_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:marktmorgen-fixture";
    process.env.VERCEL_OIDC_TOKEN = "e30.e30.fixture";
    invalidateState();
  };
  const disableSes = () => {
    for (const name of ENV_KEYS) delete process.env[name];
    invalidateState();
  };
  const setReady = async (value: boolean, quota: { max24?: number; rate?: number } = {}) => {
    ready = value;
    if (quota.max24 !== undefined) max24 = quota.max24;
    if (quota.rate !== undefined) rate = quota.rate;
    invalidateState();
  };
  const setSesOutcome = (outcome: SesFixtureOutcome | SesFixtureOutcome[]) => {
    if (Array.isArray(outcome)) queuedOutcomes = [...outcome];
    else { defaultOutcome = outcome; queuedOutcomes = []; }
  };
  const clearCaptured = () => {
    attempts.length = 0; sent.length = 0;
    sesAttempts.length = 0; resendAttempts.length = 0;
    ses.length = 0; resend.length = 0;
    calls.ses = 0; calls.resend = 0;
  };
  const clearBatch = (batchKey: string, recipients: string[]) => {
    for (const recipient of recipients) {
      const hash = createHash("sha256").update(`${batchKey}\n${recipient}`).digest("hex").slice(0, 40);
      store.run(["DEL", `nl:ses:did:${hash}`]);
    }
    const rest = createHash("sha256").update(batchKey).digest("hex").slice(0, 40);
    store.run(["DEL", `nl:ses:rest:${rest}`]);
  };
  const reset = () => {
    clearCaptured();
    calls.sts = 0; calls.account = 0;
    ready = true; max24 = 50_000; rate = 100;
    defaultOutcome = "ok"; queuedOutcomes = [];
    invalidateState();
  };

  const route = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (/^sts\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
      calls.sts += 1;
      return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: {
        Credentials: {
          AccessKeyId: "ASIAFIXTURE000000001",
          SecretAccessKey: "fixture-secret-access-key-not-real-000000",
          SessionToken: "fixture-session-token-not-real",
          Expiration: Math.floor(Date.now() / 1000) + 3_600,
        },
      } } });
    }
    if (/^email\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) &&
        url.pathname === "/v2/email/account") {
      calls.account += 1;
      return json({
        ProductionAccessEnabled: ready,
        SendingEnabled: ready,
        EnforcementStatus: ready ? "HEALTHY" : "SHUTDOWN",
        SendQuota: { Max24HourSend: max24, MaxSendRate: rate, SentLast24Hours: 0 },
      });
    }
    if (/^email\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) &&
        url.pathname === "/v2/email/outbound-emails") {
      calls.ses += 1;
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization") ?? "";
      const signed = /^AWS4-HMAC-SHA256 Credential=ASIAFIXTURE000000001\/[0-9]{8}\/us-east-1\/ses\/aws4_request,/.test(authorization)
        && /^[0-9]{8}T[0-9]{6}Z$/.test(headers.get("x-amz-date") ?? "")
        && headers.get("x-amz-security-token") === "fixture-session-token-not-real";
      if (init?.method !== "POST" || !signed) {
        return json({ message: "synthetic request was not signed for SES" }, 403, { "x-amzn-errortype": "AccessDeniedException" });
      }
      const message = normalizeSes(parseBody(init));
      attempts.push(message); sesAttempts.push(message);
      const controlled = await options.onSes?.(message, input, init);
      if (controlled) {
        if (controlled.ok) { sent.push(message); ses.push(message); }
        return controlled;
      }
      const outcome = queuedOutcomes.shift() ?? defaultOutcome;
      if (outcome === "ok") {
        sent.push(message); ses.push(message);
        return json({ MessageId: `ses_fixture_${calls.ses}` });
      }
      if (outcome === "lost") throw new TypeError("synthetic SES reply lost after possible acceptance");
      if (outcome === "server-error") return json({ message: "synthetic SES server error after possible acceptance" }, 500);
      if (outcome === "account") return json({ message: "synthetic account refusal" }, 403, { "x-amzn-errortype": "AccessDeniedException" });
      return json({ message: "synthetic confirmed message refusal" }, 400, { "x-amzn-errortype": "BadRequestException" });
    }
    if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails")) {
      calls.resend += 1;
      const parsed = parseBody(init);
      const batch = url.pathname === "/emails/batch";
      const messages = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => normalizeResend(item, batch));
      attempts.push(...messages); resendAttempts.push(...messages);
      const controlled = await options.onResend?.(messages, input, init);
      const response = controlled
        ?? (options.fallback
          ? await options.fallback(input, init)
          : json(batch
            ? { data: messages.map((_, index) => ({ id: `resend_fixture_${index + 1}` })) }
            : { id: "resend_fixture_1" }));
      if (response.ok) {
        sent.push(...messages); resend.push(...messages);
      }
      return response;
    }
    if (options.fallback) return await options.fallback(input, init);
    return new Response("synthetic endpoint not found", { status: 404 });
  };
  globalThis.fetch = route as typeof fetch;

  const restore = () => {
    globalThis.fetch = originalFetch;
    for (const name of ENV_KEYS) {
      const value = originalEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    invalidateState();
  };

  return {
    attempts, sent, sesAttempts, resendAttempts, ses, resend, calls,
    configure, disableSes, setReady, setSesOutcome, clearCaptured, clearBatch, reset, restore,
  };
}
