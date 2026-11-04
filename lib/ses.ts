/**
 * Amazon SES: the cheaper of the two services that send this site's email.
 *
 * Read before it was built (October 6, 2026): Amazon charges $0.10 for a
 * thousand emails (aws.amazon.com/ses/pricing), where the sender this site
 * started on charges $0.90 for a thousand past its plan
 * (resend.com/pricing). Nothing else that allows a creator's newsletter came
 * close: Mailgun, Postmark and MailerSend charge from $0.90 to $1.80, and
 * Cloudflare's service was reported at $0.35, in beta, and not for
 * newsletters.
 *
 * What the low price asks for in return, and where each part is answered:
 *
 *   - Amazon looks at every new account before letting it write to the
 *     public. Until then an account may send 200 emails a day, to addresses
 *     it has proved are its own. So nothing here is switched on by a
 *     setting: this file asks Amazon what the account may do (sesReady), and
 *     email goes through Amazon only once Amazon says it may. Before that,
 *     and whenever Amazon stops answering or pauses the account, everything
 *     goes through the first sender as it always did (lib/email.ts).
 *
 *   - Amazon expects the sender to look after its own bounces and spam
 *     reports, and reviews an account at 5% bounced or 0.1% reported
 *     (docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html). That is
 *     lib/mail-health.ts, which holds each store to 2% and 0.08%; Amazon
 *     tells us about each one through app/api/mail/ses.
 *
 *   - An account has a number of emails it may send in any 24 hours, and a
 *     number a second. Both are read from Amazon, never typed here, because
 *     Amazon raises them by itself as an account proves itself.
 *
 * Four settings, none of them a secret, and without all four Amazon is not
 * used at all:
 *
 *   AWS_SES_ROLE_ARN             the role at Amazon that may only send email
 *                                and read the account's own limits
 *   AWS_SES_REGION               where the account sends from: us-east-1
 *   AWS_SES_CONFIGURATION_SET    the set whose events go to the topic below
 *   AWS_SES_TOPIC_ARN            the one topic whose announcements are believed
 *
 * There is no key of Amazon's kept anywhere. The host gives every request
 * here a short-lived token that says, signed, which project of which team is
 * running (vercel.com/docs/oidc, read October 6, 2026). Amazon is told once
 * to trust that token for this one project's production, and lends a key
 * for an hour in exchange for it (sesCredentials, below). Nothing that could
 * be copied out of a settings page and used from somewhere else exists.
 *
 * Only the sending role is accepted. User access keys are not a fallback;
 * a host without a usable token cannot send through SES.
 *
 *   nl:ses:state            what Amazon last said the account may do (JSON)
 *   nl:ses:h:<YYYY-MM-DDTHH> emails Amazon took in that hour
 *   nl:ses:did:<hash>       an email of a batch Amazon already took
 */
import { createHash } from "node:crypto";
import { type AwsKey, signV4 } from "@/lib/aws-sign";
import { SES_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";

export type SesConfig = {
  /** The only identity allowed to send: a role borrowed with the host token. */
  roleArn: string;
  /** Retained shape for callers; user access keys are never accepted. */
  key: null;
  region: string;
  configurationSet: string;
  topicArn: string;
};

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** The settings, or null when any is missing or does not look like what it should be. */
export function sesConfig(): SesConfig | null {
  const role = env("AWS_SES_ROLE_ARN");
  const region = env("AWS_SES_REGION");
  const configurationSet = env("AWS_SES_CONFIGURATION_SET");
  const topicArn = env("AWS_SES_TOPIC_ARN");
  const roleArn = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,128}$/.test(role) ? role : null;
  if (!roleArn) return null;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(configurationSet)) return null;
  // The topic must be in the region email is sent from: its announcements
  // are signed by that region's certificate (lib/sns.ts).
  const arn = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(topicArn);
  if (!arn || arn[1] !== region) return null;
  return { roleArn, key: null, region, configurationSet, topicArn };
}

/* ------------------------------------------------------------------ */
/* A key for an hour, in exchange for the host's token                 */
/* ------------------------------------------------------------------ */

/**
 * The token the host gives the request being served, saying which project
 * is running. Read the way the host's own helper reads it (@vercel/oidc
 * 4.0.0, get-vercel-oidc-token-sync.js): from the request's context while a
 * function runs, from the environment while a build or a local run does.
 */
function hostToken(): string | null {
  const context = (globalThis as Record<symbol, { get?: () => { headers?: Record<string, string | undefined> } } | undefined>)[
    Symbol.for("@vercel/request-context")
  ];
  let token: string | undefined;
  try {
    token = context?.get?.()?.headers?.["x-vercel-oidc-token"];
  } catch {
    token = undefined;
  }
  token = token || process.env.VERCEL_OIDC_TOKEN?.trim();
  return token && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

/**
 * What Amazon is told to trust (infra/amazon-ses.yml): a token from this
 * issuer, for this audience, naming this project's production. A project or
 * a team renamed changes what the host writes in the token, and Amazon would
 * then lend nothing, so the daily check holds the token to these
 * (lib/verify-mail.ts) and tests/ses-sender.test.ts holds the stack to them.
 */
export const TRUSTED_TOKEN = {
  iss: "https://oidc.vercel.com/viniciussucupira",
  aud: "https://vercel.com/viniciussucupira",
  sub: "owner:viniciussucupira:project:marktmorgen:environment:production",
};

/**
 * What the host's token on this request says, unverified: who issued it, for
 * whom, about which project, and when it ends. Amazon is the one that checks
 * its signature; this is for saying, in a log, what Amazon will be shown.
 * None of it is secret. Null when the request has no token.
 */
export function hostTokenClaims(): { iss: string; aud: string; sub: string; exp: number } | null {
  const token = hostToken();
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");
    return { iss: text(claims.iss), aud: text(claims.aud), sub: text(claims.sub), exp: Number(claims.exp) || 0 };
  } catch {
    return null;
  }
}

/** The key lent for the role, kept in this instance's memory only, until five minutes before Amazon ends it. */
let lent: { role: string; key: AwsKey; until: number } | null = null;
/** After Amazon refuses the exchange, it is not asked again for a minute. */
let refusedUntil = 0;

const between = (text: string, tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text)?.[1] ?? "";

/**
 * The temporary key Amazon lends to the sending role for an hour in
 * exchange for the host's token. Null when
 * Amazon will not lend one — no token on this request, or a role that does
 * not trust it — and then Amazon is simply not used.
 */
export async function sesCredentials(config: SesConfig, now = Date.now()): Promise<AwsKey | null> {
  if (!config.roleArn) return null;
  if (lent && lent.role === config.roleArn && now < lent.until) return lent.key;
  if (now < refusedUntil) return null;
  const token = hostToken();
  if (!token) {
    console.error("Amazon SES: no token from the host on this request, so no key can be borrowed");
    refusedUntil = now + 60_000;
    return null;
  }
  try {
    const response = await timed(SES_TIMEOUT_MS, (signal) =>
      fetch(`https://sts.${config.region}.amazonaws.com/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          Action: "AssumeRoleWithWebIdentity",
          Version: "2011-06-15",
          RoleArn: config.roleArn as string,
          RoleSessionName: "marktmorgen-email",
          WebIdentityToken: token,
          DurationSeconds: "3600",
        }).toString(),
        cache: "no-store",
        signal,
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      // What Amazon says here is the reason, and holds nothing secret: a
      // role that does not trust this project, a token past its time.
      console.error("Amazon would not lend a key for the role", response.status, text.replace(/\s+/g, " ").slice(0, 300));
      refusedUntil = now + 60_000;
      return null;
    }
    // Amazon answers in JSON when asked to, and in XML otherwise; either is read.
    let accessKeyId = "";
    let secretAccessKey = "";
    let sessionToken = "";
    let expires = 0;
    try {
      const c = (JSON.parse(text) as { AssumeRoleWithWebIdentityResponse?: { AssumeRoleWithWebIdentityResult?: { Credentials?: Record<string, unknown> } } })
        .AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials;
      accessKeyId = typeof c?.AccessKeyId === "string" ? c.AccessKeyId : "";
      secretAccessKey = typeof c?.SecretAccessKey === "string" ? c.SecretAccessKey : "";
      sessionToken = typeof c?.SessionToken === "string" ? c.SessionToken : "";
      expires = typeof c?.Expiration === "number" ? c.Expiration * 1000 : Date.parse(String(c?.Expiration ?? ""));
    } catch {
      accessKeyId = between(text, "AccessKeyId");
      secretAccessKey = between(text, "SecretAccessKey");
      sessionToken = between(text, "SessionToken");
      expires = Date.parse(between(text, "Expiration"));
    }
    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      console.error("Amazon's answer to the exchange held no key");
      refusedUntil = now + 60_000;
      return null;
    }
    const until = (Number.isFinite(expires) && expires > now ? expires : now + 3_600_000) - 300_000;
    lent = { role: config.roleArn, key: { accessKeyId, secretAccessKey, sessionToken }, until };
    return lent.key;
  } catch (error) {
    console.error("Amazon could not be asked for a key", error);
    refusedUntil = now + 60_000;
    return null;
  }
}

/** Whether Amazon could be used at all. It also needs Redis: what it may do, and what it took, are kept there. */
export function isSesConfigured(): boolean {
  return sesConfig() !== null && isRedisConfigured();
}

const base = (config: SesConfig) => `https://email.${config.region}.amazonaws.com`;

async function call(config: SesConfig, method: "GET" | "POST", path: string, body?: string): Promise<Response> {
  const url = `${base(config)}${path}`;
  const key = await sesCredentials(config);
  // No key to sign with is answered as Amazon answers a key it does not
  // believe, so every caller treats the two alike: Amazon is not usable.
  if (!key) return new Response(JSON.stringify({ message: "no key could be borrowed for the role" }), { status: 403, headers: { "x-amzn-errortype": "AccessDenied" } });
  const headers = signV4({
    method,
    url,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body,
    region: config.region,
    service: "ses",
    key,
  });
  // `host` is set by fetch itself, from the address; it was needed for the signature only.
  const { host: _host, ...sent } = headers;
  void _host;
  return timed(SES_TIMEOUT_MS, (signal) => fetch(url, { method, headers: sent, body, cache: "no-store", signal }));
}

/* ------------------------------------------------------------------ */
/* What the account may do                                             */
/* ------------------------------------------------------------------ */

export type SesState = {
  /** Amazon lets this account write to the public, now. */
  ready: boolean;
  /** Why not, in a word, when it does not: "sandbox", "off", "shutdown", "unreachable", or what a send was refused with. */
  why: string;
  /** Emails a second, and in any 24 hours; only max24 = -1 denotes unlimited quota. */
  rate: number;
  max24: number;
  /** Cache freshness/retry anchor, and the end of a sender-refusal hold (seconds). */
  at: number;
  hold: number;
};

const STATE_KEY = "nl:ses:state";
/** How long an answer from Amazon is believed before it is asked again. */
const BELIEVED_SECONDS = 300;
/** How long Amazon is left alone after it refused a send for the account's own sake. */
export const HOLD_SECONDS = 600;
/** How long a state is kept at all: past this, with Amazon not answering, it is not used. */
const KEPT_SECONDS = 3_600;

/** Only documented numeric quota evidence may authorize SES. */
function accountRate(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && raw <= Number.MAX_SAFE_INTEGER ? raw : null;
}

function accountMax(raw: unknown): number | null {
  if (raw === -1) return -1; // The documented unlimited-quota sentinel.
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 && raw <= Number.MAX_SAFE_INTEGER ? Math.floor(raw) : null;
}

function parseState(raw: unknown): SesState | null {
  if (typeof raw !== "string" || raw.length > 1_024) return null;
  try {
    const v = JSON.parse(raw) as Partial<SesState> | null;
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.ready !== "boolean" ||
        typeof v.why !== "string" || v.why.length > 300 ||
        typeof v.rate !== "number" || !Number.isFinite(v.rate) || v.rate < 0 || v.rate > Number.MAX_SAFE_INTEGER ||
        typeof v.max24 !== "number" || !Number.isSafeInteger(v.max24) || v.max24 < -1 ||
        typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0 ||
        typeof v.hold !== "number" || !Number.isSafeInteger(v.hold) || v.hold < 0) return null;
    if (v.ready && (v.why !== "" || v.hold !== 0 || accountRate(v.rate) === null || accountMax(v.max24) === null)) return null;
    return { ready: v.ready, why: v.why, rate: v.rate, max24: v.max24, at: v.at, hold: v.hold };
  } catch {
    return null;
  }
}

const saveState = (state: SesState) => redisPipeline([["SET", STATE_KEY, JSON.stringify(state), "EX", KEPT_SECONDS]]);

/** Asks Amazon what the account may do. Null when it did not answer. */
async function askAccount(config: SesConfig, now: number): Promise<SesState | null> {
  try {
    const response = await call(config, "GET", "/v2/email/account");
    if (!response.ok) {
      console.error("Amazon SES would not say what the account may do", response.status);
      // A key that is wrong, or was taken away, is an answer: not usable.
      return response.status === 403 || response.status === 401 ? { ready: false, why: "key", rate: 0, max24: 0, at: now, hold: 0 } : null;
    }
    const a = (await response.json()) as {
      ProductionAccessEnabled?: unknown;
      SendingEnabled?: unknown;
      EnforcementStatus?: unknown;
      SendQuota?: { Max24HourSend?: unknown; MaxSendRate?: unknown };
    };
    if (!a || typeof a !== "object" || Array.isArray(a)) return { ready: false, why: "status", rate: 0, max24: 0, at: now, hold: 0 };
    let why = a.ProductionAccessEnabled !== true ? "sandbox" : a.SendingEnabled !== true ? "off" :
      a.EnforcementStatus === "SHUTDOWN" ? "shutdown" :
      a.EnforcementStatus === "HEALTHY" || a.EnforcementStatus === "PROBATION" ? "" : "status";
    const rate = accountRate(a.SendQuota?.MaxSendRate);
    const max24 = accountMax(a.SendQuota?.Max24HourSend);
    // The current batch pacer supports at least one email a second. Missing,
    // zero, coerced or unsupported quota data is not permission to send.
    if (!why && (rate === null || max24 === null)) why = "quota";
    return { ready: why === "", why, rate: rate ?? 0, max24: max24 ?? 0, at: now, hold: 0 };
  } catch (error) {
    console.error("Amazon SES could not be reached", error);
    return null;
  }
}

/**
 * What Amazon last said, asked again when that is more than five minutes
 * old. Null when the settings are not there; "not ready" for every reason
 * Amazon cannot be used right now.
 */
export async function sesState(now = Date.now()): Promise<SesState | null> {
  const config = sesConfig();
  if (!config || !isRedisConfigured()) return null;
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(now) || now < 0 || !Number.isSafeInteger(seconds)) return null;
  let known: SesState | null = null;
  try {
    const reply: unknown = await redisPipeline([["GET", STATE_KEY]]);
    if (!Array.isArray(reply)) return null;
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    if (!length || !("value" in length) || length.value !== 1) return null;
    const item = Object.getOwnPropertyDescriptor(reply, "0");
    if (!item || !("value" in item)) return null;
    known = parseState(item.value);
  } catch {
    return null;
  }
  // A future timestamp is not evidence that the account was checked recently.
  if (known && known.at <= seconds && (seconds < known.hold || seconds - known.at < BELIEVED_SECONDS)) return known;
  const asked = await askAccount(config, seconds);
  if (asked) {
    await saveState(asked).catch(() => {});
    return asked;
  }
  // A failed refresh is not renewed permission to send under an old answer.
  // Reuse the existing one-minute retry anchor and cache write, without
  // preserving ready=true indefinitely by extending its timestamp and TTL.
  const unavailable: SesState = {
    ready: false, why: "unreachable", rate: known?.rate ?? 0, max24: known?.max24 ?? 0,
    at: seconds - BELIEVED_SECONDS + 60, hold: 0,
  };
  await saveState(unavailable).catch(() => {});
  return unavailable;
}

/** The account's limits when Amazon may be used right now; null when it may not. */
export async function sesReady(now = Date.now()): Promise<SesState | null> {
  const state = await sesState(now);
  return state?.ready ? state : null;
}

/**
 * Amazon refused a send for a reason that is the account's, not the email's:
 * it is left alone for ten minutes, and then asked what the account may do.
 */
export async function sesDown(why: string, seconds = HOLD_SECONDS, now = Date.now()): Promise<void> {
  if (!isRedisConfigured()) return;
  const at = Math.floor(now / 1000);
  let known: SesState | null = null;
  try {
    known = parseState((await redisPipeline([["GET", STATE_KEY]]))[0]);
  } catch {
    known = null;
  }
  await saveState({ ready: false, why, rate: known?.rate ?? 0, max24: known?.max24 ?? 0, at, hold: at + seconds }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* What Amazon took                                                    */
/* ------------------------------------------------------------------ */

// A rolling 24-hour interval may touch 25 UTC hourly buckets. Retain the
// first partial hour conservatively; the same pipeline reads one extra key.
const SES_USAGE_BUCKETS = 25;
const hourKey = (ms: number) => `nl:ses:h:${new Date(ms).toISOString().slice(0, 13)}`;

export async function countSesSent(n: number, now = Date.now()): Promise<void> {
  if (n <= 0 || !isRedisConfigured()) return;
  const key = hourKey(now);
  await redisPipeline([
    ["INCRBY", key, n],
    ["EXPIRE", key, 26 * 3_600],
  ]).catch(() => {});
}

/** Conservative rolling usage: the current hour and the preceding 24 whole
 * hourly buckets. The first partial hour may overcount by less than an hour,
 * never omit a send still within the last 24 hours. Null when unproved. */
export async function sesSentLast24h(now = Date.now()): Promise<number | null> {
  if (!isRedisConfigured()) return null;
  try {
    const keys = Array.from({ length: SES_USAGE_BUCKETS }, (_, i) => hourKey(now - i * 3_600_000));
    const rows: unknown = await redisPipeline(keys.map((key) => ["GET", key]));
    if (!Array.isArray(rows)) return null;
    const length = Object.getOwnPropertyDescriptor(rows, "length");
    if (!length || !Object.hasOwn(length, "value") || length.value !== SES_USAGE_BUCKETS) return null;
    let total = 0;
    for (let i = 0; i < SES_USAGE_BUCKETS; i += 1) {
      const item = Object.getOwnPropertyDescriptor(rows, String(i));
      if (!item || !Object.hasOwn(item, "value")) return null;
      if (item.value === null) continue; // Explicit absence is known zero.
      if (typeof item.value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(item.value)) return null;
      const count = Number(item.value);
      if (!Number.isSafeInteger(count) || count > Number.MAX_SAFE_INTEGER - total) return null;
      total += count;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * The share of Amazon's 24 hours that email sent many at a time may use. The
 * rest is kept for what goes one at a time and cannot wait: a sign-in link,
 * a receipt, the email that hands a buyer their file.
 */
export const SES_BULK_SHARE = 0.8;

/** Recorded bulk room; null when usage cannot be proved. Infinity for an account with no limit. */
export async function sesBulkRoom(state: SesState, now = Date.now()): Promise<number | null> {
  if (typeof state.max24 !== "number" || !Number.isSafeInteger(state.max24) || state.max24 < -1) return null;
  if (state.max24 === -1) return Number.POSITIVE_INFINITY;
  if (state.max24 === 0) return 0;
  const sent = await sesSentLast24h(now);
  return sent === null ? null : Math.max(0, Math.floor(state.max24 * SES_BULK_SHARE) - sent);
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

export type SesMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string }[];
  tags?: { name: string; value: string }[];
};

/**
 * What became of one email handed to Amazon:
 *
 *   "sent"     Amazon took it.
 *   "busy"     Not taken, and it is nobody's fault: too many a second, an
 *              error on Amazon's side, no answer in time.
 *   "account"  Not taken, for a reason that is the account's: paused, shut,
 *              a sending address not proved, a key that is not believed, the
 *              day's emails used. Every other email would meet the same.
 *   "refused"  Not taken, for a reason that is this email's own.
 */
export type SesOutcome = "sent" | "busy" | "account" | "refused";

const ACCOUNT_ERRORS = /AccountSuspended|SendingPaused|MailFromDomainNotVerified|LimitExceeded|AccessDenied|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClient|ExpiredToken|NotFound/i;

export async function sesSend(config: SesConfig, message: SesMessage): Promise<{ outcome: SesOutcome; why: string; uncertain?: true }> {
  const payload = JSON.stringify({
    FromEmailAddress: message.from,
    Destination: { ToAddresses: [message.to] },
    ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.text, Charset: "UTF-8" },
          ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
        },
        ...(message.headers && Object.keys(message.headers).length
          ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
          : {}),
        ...(message.attachments?.length
          ? { Attachments: message.attachments.map((a) => ({ FileName: a.filename, RawContent: a.content })) }
          : {}),
      },
    },
    ...(message.tags?.length ? { EmailTags: message.tags.map((t) => ({ Name: t.name, Value: t.value })) } : {}),
    // Without the set, Amazon would not tell us when this email bounced.
    ConfigurationSetName: config.configurationSet,
  });
  try {
    const response = await call(config, "POST", "/v2/email/outbound-emails", payload);
    if (response.ok) return { outcome: "sent", why: "" };
    // SES can accept a message before returning a server error. This is not
    // a confirmed refusal; sends must not retry or change sender.
    // Read no error body before preserving that distinction.
    if (response.status >= 500) return { outcome: "busy", why: `SES ${response.status}: acceptance unknown`, uncertain: true };
    const type = response.headers.get("x-amzn-errortype") ?? "";
    let said = "";
    try {
      const body = (await response.json()) as { message?: unknown; Message?: unknown; __type?: unknown };
      said = `${typeof body.__type === "string" ? body.__type : ""} ${typeof body.message === "string" ? body.message : typeof body.Message === "string" ? body.Message : ""}`;
    } catch {
      said = "";
    }
    const why = `${response.status} ${type} ${said}`.replace(/\s+/g, " ").trim().slice(0, 300);
    if (response.status === 429 && !/quota/i.test(why)) return { outcome: "busy", why };
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429) return { outcome: "account", why };
    // An address not proved, in an account still in its sandbox or sending
    // from a domain it has not proved, comes back as the email's own fault.
    if (ACCOUNT_ERRORS.test(why) || /not verified|sandbox|quota/i.test(why)) return { outcome: "account", why };
    return { outcome: "refused", why };
  } catch (error) {
    // A lost response is not proof that SES did not accept the message.
    return { outcome: "busy", why: error instanceof Error ? error.message.slice(0, 200) : "no answer", uncertain: true };
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const didKey = (batchKey: string, to: string) => `nl:ses:did:${createHash("sha256").update(`${batchKey}\n${to}`).digest("hex").slice(0, 40)}`;
const DID_SECONDS = 2 * 86_400;

/**
 * Recipients whose existing marker explicitly confirms absence. A known
 * marker leaves that recipient out; null means evidence is unavailable,
 * never permission to send. This preflight is not proof of delivery or
 * lifetime idempotency after an uncertain provider response.
 */
export async function notYetTaken<T extends { to: string }>(batchKey: string, messages: T[]): Promise<T[] | null> {
  if (!messages.length) return messages;
  // sendBatch already caps a request at 100; validate only that finite window.
  if (messages.length > 100) return null;
  try {
    const found: unknown = await redisPipeline(messages.map((m) => ["GET", didKey(batchKey, m.to)]));
    if (!Array.isArray(found)) return null;
    const length = Object.getOwnPropertyDescriptor(found, "length");
    if (!length || !("value" in length) || length.value !== messages.length) return null;
    const pending: T[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const item = Object.getOwnPropertyDescriptor(found, String(i));
      if (!item || !("value" in item)) return null;
      // Only explicit absence permits sending. Missing, inherited, computed
      // or unexpected evidence is not proof that SES never took the message.
      if (item.value === null) pending.push(messages[i]);
      else if (item.value !== "1") return null;
    }
    return pending;
  } catch {
    return null;
  }
}

/** The longest one batch may take here; what is left after it goes by the other sender. */
const BATCH_MS = 9_000;

/**
 * Hands a batch to Amazon one email at a time, no faster than the account
 * may send, and says which it took and which are left for the other sender:
 * the ones not reached in time, and all of them from the moment Amazon
 * refuses one for the account's own sake. One it refused for the email's own
 * sake is in neither: it is not sent by anybody. An uncertain acceptance
 * stops new waves and rounds; callers must not hand its remainder elsewhere.
 */
export async function sesBatch<T extends SesMessage>(
  config: SesConfig,
  state: SesState,
  messages: T[],
  batchKey: string,
): Promise<{ taken: T[]; left: T[]; down: string; uncertain?: true }> {
  const taken: T[] = [];
  const refused = new Set<T>();
  const perSecond = Math.max(1, Math.floor(state.rate || 1));
  const started = Date.now();
  let down = "";
  let uncertain = false;
  let queue = [...messages];
  for (let round = 0; round < 2 && queue.length && !down && !uncertain; round += 1) {
    const again: T[] = [];
    for (let i = 0; i < queue.length && !down && !uncertain; i += perSecond) {
      if (Date.now() - started > BATCH_MS) {
        again.push(...queue.slice(i));
        break;
      }
      const waveStarted = Date.now();
      const wave = queue.slice(i, i + perSecond);
      const results = await Promise.all(wave.map((m) => sesSend(config, m)));
      const done: T[] = [];
      results.forEach((result, j) => {
        if (result.uncertain === true) {
          // A provider may have accepted this email before losing its reply.
          // Keep it unresolved, with no second attempt in this call.
          uncertain = true;
          again.push(wave[j]);
        } else if (result.outcome === "sent") done.push(wave[j]);
        else if (result.outcome === "refused") {
          refused.add(wave[j]);
          console.error("Amazon SES refused an email", result.why);
        } else {
          again.push(wave[j]);
          if (result.outcome === "account" && !down) down = result.why || "account";
        }
      });
      if (done.length) {
        taken.push(...done);
        // Written down at once, so a batch cut short here and tried again
        // leaves these people out.
        await redisPipeline(done.map((m) => ["SET", didKey(batchKey, m.to), "1", "EX", DID_SECONDS])).catch(() => {});
      }
      if (down || uncertain) again.push(...queue.slice(i + perSecond));
      else if (i + perSecond < queue.length) await pause(Math.max(0, 1_000 - (Date.now() - waveStarted)));
    }
    queue = again;
    if (queue.length && !down && !uncertain && round === 0) {
      if (Date.now() - started > BATCH_MS) break;
      await pause(1_000);
    }
  }
  return { taken, left: queue.filter((m) => !refused.has(m)), down, ...(uncertain ? { uncertain: true as const } : {}) };
}
