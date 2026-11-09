import { addProduct, setProductLink, setStripeAccount } from "@/lib/store";
import { confirmPurchase, confirmationKey } from "@/lib/purchase-email";
/**
 * Email goes through Amazon SES when Amazon says it may, and through Resend
 * whenever it may not — with nobody choosing, nothing lost, and nobody
 * written to twice (lib/email.ts, lib/ses.ts).
 *
 * Amazon is the cheaper sender by nine times, and the one with more ways to
 * say no: a new account is looked at before it may write to the public, an
 * account has a number of emails for any 24 hours and for any second, and
 * Amazon pauses one whose email bounces too much. Each of those is stood in
 * for here, and each must end the same way: the email arrives.
 *
 * The last parts are the other direction: Amazon telling us an email
 * bounced (app/api/mail/ses), believed only from our own topic and with
 * Amazon's signature.
 */
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/ses/route";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { isMailable, upsertContact } from "@/lib/contacts";
import { hasResend, isSenderConfigured, sendBatch, sendListBatch, sendEmail, sentKey, sentThisMonth } from "@/lib/email";
import { listCeiling, reserve as reserveMail, reserveDay, senderRoom } from "@/lib/mail";
import { LIST_TAG, STORE_TAG, healthId, listHealth } from "@/lib/mail-health";
import { HOLD_SECONDS, isSesConfigured, notYetTaken, sesBulkRoom, sesConfig, sesSentLast24h, sesState } from "@/lib/ses";
import { stringToSign, type SnsMessage } from "@/lib/sns";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const REGION = "us-east-1";
const TOPIC = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
const SUPPORT = "support@marktmorgen.com";

type AmazonSent = { to: string; subject: string; body: Record<string, unknown>; headers: Record<string, string> };
type ResendSent = { to: string; subject: string; key: string | null };
const amazon: AmazonSent[] = [];
const resend: ResendSent[] = [];
const resendKeys = new Map<string, string>();
let asked = 0;
let account: Record<string, unknown> | number = 0;
let accountLosesReply = false;
/** What Amazon answers to a send, by recipient; anything not named is taken. */
let amazonSays: (to: string, nth: number) => { status: number; type?: string; message?: string } = () => ({ status: 200 });
/** Synthetic only: SES accepted the message before its acknowledgement was lost. */
let amazonLosesReply: (to: string) => number | "throw" | null = () => null;
const fetched: string[] = [];
const exchanges: { role: string; token: string; action: string }[] = [];
let stsRefuses = false;
let stsAnswersXml = false;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT = publicKey.export({ type: "spki", format: "pem" }).toString();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") {
      asked += 1;
      if (accountLosesReply) throw new TypeError("synthetic account refresh reply lost");
      return typeof account === "number" ? json({ message: "no" }, account || 500) : json(account);
    }
    if (url.pathname === "/v2/email/outbound-emails") {
      const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] }; Content: { Simple: { Subject: { Data: string } } } };
      const to = body.Destination.ToAddresses[0];
      const says = amazonSays(to, amazon.filter((a) => a.to === to).length);
      if (says.status !== 200) return json({ message: says.message ?? "" }, says.status, says.type ? { "x-amzn-errortype": says.type } : {});
      amazon.push({ to, subject: body.Content.Simple.Subject.Data, body: body as unknown as Record<string, unknown>, headers: init?.headers as Record<string, string> });
      const lost = amazonLosesReply(to);
      if (lost === "throw") throw new TypeError("synthetic response lost after SES acceptance");
      if (typeof lost === "number") return json({ message: "synthetic server error after acceptance" }, lost);
      return json({ MessageId: `m-${amazon.length}` });
    }
    return json({}, 404);
  }
  if (url.hostname === "api.resend.com") {
    const key = (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null;
    const bytes = String(init?.body);
    const body = JSON.parse(bytes) as { to: string[]; subject: string } | { to: string[]; subject: string }[];
    // Resend answers a key it has seen without sending again.
    if (key && resendKeys.has(key) && resendKeys.get(key) !== bytes) return json({ name: "invalid_idempotent_request" }, 409);
    if (key && resendKeys.has(key)) return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `again_${i}` })) } : { id: "again" });
    if (key) resendKeys.set(key, bytes);
    for (const m of Array.isArray(body) ? body : [body]) resend.push({ to: m.to[0], subject: m.subject, key });
    return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i + 1}` })) } : { id: "email_1" });
  }
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const form = new URLSearchParams(String(init?.body));
    exchanges.push({ role: form.get("RoleArn") ?? "", token: form.get("WebIdentityToken") ?? "", action: form.get("Action") ?? "" });
    if (stsRefuses) return json({ Error: { Code: "AccessDenied", Message: "Not authorized to perform sts:AssumeRoleWithWebIdentity" } }, 403);
    const credentials = { AccessKeyId: `ASIAEXAMPLELENT${exchanges.length}`, SecretAccessKey: "lent-for-an-hour-and-never-stored-0000000", SessionToken: `session-token-${exchanges.length}`, Expiration: Math.floor(Date.now() / 1000) + 3_600 };
    return stsAnswersXml
      ? new Response(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${credentials.AccessKeyId}</AccessKeyId><SecretAccessKey>${credentials.SecretAccessKey}</SecretAccessKey><SessionToken>${credentials.SessionToken}</SessionToken><Expiration>${new Date(credentials.Expiration * 1000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`)
      : json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
  }
  fetched.push(url.href);
  if (url.hostname === `sns.${REGION}.amazonaws.com`) return new Response(url.pathname.endsWith(".pem") ? CERT : "<ok/>");
  return json({}, 404);
}) as typeof fetch;

const approved = (extra: Record<string, unknown> = {}) => ({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 100, SentLast24Hours: 0 }, ...extra });
/** Amazon is asked again on the next email, as it is once five minutes have passed. */
const askAgain = () => redis.run(["DEL", "nl:ses:state"]);
const clear = () => {
  amazon.length = 0;
  resend.length = 0;
};
const letter = (to: string, subject = "Hello") => ({ meter: { by: "company" } as const, from: "Marktmorgen <hello@marktmorgen.com>", to, subject, text: "Hello.", html: "<p>Hello.</p>" });

let announced = 0;
function announce(over: Partial<SnsMessage> & { event?: unknown }, opts: { sign?: boolean } = {}): NextRequest {
  announced += 1;
  const base: SnsMessage = {
    Type: "Notification",
    MessageId: `sns-${announced}`,
    TopicArn: TOPIC,
    Message: JSON.stringify(over.event ?? {}),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc.pem`,
  };
  const { event: _event, ...fields } = over;
  void _event;
  const message: SnsMessage = { ...base, ...fields };
  if (!over.Signature) {
    const signed = createSign(message.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256").update(stringToSign(message), "utf8").sign(privateKey, "base64");
    message.Signature = opts.sign === false ? signed.replace(/^./, (c) => (c === "A" ? "B" : "A")) : signed;
  }
  const body = JSON.stringify(message);
  return new NextRequest("https://marktmorgen.com/api/mail/ses", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "text/plain; charset=UTF-8", "content-length": String(Buffer.byteLength(body)), "x-amz-sns-message-type": message.Type },
    body,
  });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_floor_only_a_stand_in";
  for (const name of ["AWS_SES_ROLE_ARN", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "SENDER_MONTHLY_QUOTA", "VERCEL_OIDC_TOKEN"]) delete process.env[name];

  part("Not used until every setting is there");
  is("with none, Amazon is not there and Resend sends", [isSesConfigured(), isSenderConfigured(), hasResend()], [false, true, true]);
  is("and nothing is found at the address Amazon would post to", (await POST(announce({}))).status, 404);
  process.env.AWS_SES_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE00";
  process.env.AWS_SES_SECRET_ACCESS_KEY = "a-stand-in-secret-for-tests-only-0000000";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  is("without the topic, not yet", isSesConfigured(), false);
  process.env.AWS_SES_TOPIC_ARN = "arn:aws:sns:eu-west-1:123456789012:marktmorgen-email";
  is("a topic in another region than the one email leaves from is not believed", isSesConfigured(), false);
  process.env.AWS_SES_TOPIC_ARN = TOPIC;
  is("a user access key alone cannot configure SES", [isSesConfigured(), sesConfig()], [false, null]);
  process.env.AWS_SES_ROLE_ARN = "not-a-role";
  is("an invalid role cannot fall back to the user key", [isSesConfigured(), sesConfig()], [false, null]);
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  is("the complete role configuration ignores user access keys", [isSesConfigured(), sesConfig()?.region, sesConfig()?.roleArn, sesConfig()?.key],
    [true, REGION, "arn:aws:iam::123456789012:role/synthetic-baseline", null]);

  part("An account Amazon is still looking at");
  account = { ProductionAccessEnabled: false, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 200, MaxSendRate: 1 } };
  is("a sign-in link is sent", await sendEmail(letter("buyer@example.com", "Your login link")), true);
  is("through Resend, as it always was", [amazon.length, resend.map((m) => m.to)], [0, ["buyer@example.com"]]);
  is("because Amazon said the account may not write to the public yet", (await sesState())?.why, "sandbox");
  is("a batch goes the same way", [await sendBatch([letter("a@example.com"), letter("b@example.com")], "k:sandbox", { by: "company" }), amazon.length, resend.length], ["sent", 0, 3]);
  const askedSoFar = asked;
  await sendEmail(letter("c@example.com"));
  is("and Amazon is not asked again for every email", asked, askedSoFar);

  part("The day Amazon says yes, sending moves by itself");
  account = approved();
  askAgain();
  clear();
  is("the next sign-in link is sent", await sendEmail({ ...letter("buyer@example.com", "Your login link"), replyTo: "owner@example.com", headers: { "List-Unsubscribe": "<https://marktmorgen.com/u>" } }), true);
  is("through Amazon, and not through Resend as well", [amazon.length, resend.length], [1, 0]);
  const one = amazon[0];
  is("signed for Amazon's email service in that region", [/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLELENT1\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/.test(one.headers.authorization), /^\d{8}T\d{6}Z$/.test(one.headers["x-amz-date"])], [true, true]);
  is("from, to, reply-to and subject as written", [one.body.FromEmailAddress, (one.body.Destination as { ToAddresses: string[] }).ToAddresses, one.body.ReplyToAddresses, one.subject], ["Marktmorgen <hello@marktmorgen.com>", ["buyer@example.com"], ["owner@example.com"], "Your login link"]);
  const simple = (one.body.Content as { Simple: { Body: { Text: { Data: string }; Html: { Data: string } }; Headers: unknown } }).Simple;
  is("the text and the page, and the header a mail app unsubscribes with", [simple.Body.Text.Data, simple.Body.Html.Data, simple.Headers], ["Hello.", "<p>Hello.</p>", [{ Name: "List-Unsubscribe", Value: "<https://marktmorgen.com/u>" }]]);
  is("under the set whose events come back to us", one.body.ConfigurationSetName, "marktmorgen");
  is("counted as Amazon's, and not against Resend's month", [await sesSentLast24h(), await sentThisMonth()], [1, 4]);

  part("Once means once");
  clear();
  const receipt = { ...letter("buyer@example.com", "Your receipt"), idempotencyKey: "receipt:cs_test_1" };
  is("the first send is confirmed; its legacy claim alone cannot confirm replay", [await sendEmail(receipt), await sendEmail(receipt)], [true, false]);
  is("is sent one time", [amazon.length, resend.length], [1, 0]);

  part("An uncertain once-only claim holds both actual senders");
  const originalPipeline = redis.pipeline;
  let memberReads = 0;
  let getterReads = 0;
  const malformed: [string, () => unknown][] = [
    ["undefined", () => undefined],
    ["non-array", () => ({ 0: "OK", length: 1 })],
    ["empty", () => []],
    ["sparse", () => new Array(1)],
    ["inherited", () => Object.setPrototypeOf(new Array(1), { 0: "OK" })],
    ["accessor", () => Object.defineProperty(new Array(1), "0", { get() { getterReads += 1; return "OK"; } })],
    ["symbol", () => [Symbol("OK")]],
    ["unexpected", () => [true]],
    ["oversized", () => new Proxy(["OK", "extra"], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") memberReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["throw after commit", () => { throw new Error("synthetic lost claim acknowledgement"); }],
  ];
  for (const [name, answer] of malformed) {
    clear();
    const key = `receipt:uncertain:${name}`;
    const claim = `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const counted = [await sesSentLast24h(), await sentThisMonth()];
    let claims = 0;
    let deletes = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((command) => command[0] === "DEL" && command[1] === claim)) deletes += 1;
      if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === claim) {
        claims += 1;
        await originalPipeline(commands); // Actual synthetic claim committed first.
        return answer() as unknown[];
      }
      return originalPipeline(commands);
    };
    try {
      is(`${name}: no delivery claim or provider fallback`,
        [await sendEmail({ ...letter("uncertain@example.com"), idempotencyKey: key }), amazon.length, resend.length],
        [false, 0, 0]);
    } finally {
      redis.pipeline = originalPipeline;
    }
    is(`${name}: one claim, no deletion, committed claim retained`, [claims, deletes, redis.run(["GET", claim])], [1, 0, "1"]);
    is(`${name}: no sender count consumed`, [await sesSentLast24h(), await sentThisMonth()], counted);
  }
  is("malformed members were never read", [getterReads, memberReads], [0, 0]);
  clear();
  const controlKey = "receipt:own-ack-control";
  const controlClaim = `nl:ses:once:${createHash("sha256").update(controlKey).digest("hex").slice(0, 40)}`;
  redis.pipeline = async (commands) => {
    const result = await originalPipeline(commands);
    return commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === controlClaim
      ? new Proxy(result, { getOwnPropertyDescriptor(target, key) {
        if (key === "0") memberReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      } })
      : result;
  };
  try {
    is("a confirmed own OK still reaches Amazon", await sendEmail({ ...letter("control@example.com"), idempotencyKey: controlKey }), true);
  } finally {
    redis.pipeline = originalPipeline;
  }
  is("the positive probe sees the sole member and one sender", [memberReads, amazon.length, resend.length], [1, 1, 0]);

  part("An existing legacy SES claim cannot certify a purchase confirmation");
  const auditOwner = "legacy-audit-owner@example.test";
  await claimHandle(auditOwner, "legacyaudit", "Synthetic legacy audit", "");
  await ensureStatsId(auditOwner);
  await setStripeAccount(auditOwner, "acct_audit0001", true);
  await setSubscription(auditOwner, { customerId: "cus_LegacyAudit0001", subscriptionId: "sub_LegacyAudit0001", active: true, period: paidPeriod() });
  const auditMade = await addProduct(auditOwner, "Synthetic audit product", "", "49", null);
  if (!auditMade.ok) throw new Error("Synthetic audit product unavailable");
  await setProductLink(auditOwner, auditMade.product.id, "https://example.test/audit-only");
  const auditStore = (await storeForEmail(auditOwner))!;
  const auditPaid = (sessionId: string) => ({ id: sessionId, status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000), amount_total: 4900, currency: "usd", payment_intent: "pi_LegacyAudit0001",
    metadata: { store: "legacyaudit", product: auditMade.product.id }, customer_details: { email: "legacy-audit-buyer@example.test" } }) as never;
  for (const loss of ["claim-ack-before-post", "ses-ack-after-post"] as const) {
    account = approved(); askAgain(); clear();
    const sessionId = "cs_test_" + (loss === "claim-ack-before-post" ? "a" : "b").repeat(24);
    const key = `nimbus-confirm:${sessionId}`;
    const claim = `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const session = auditPaid(sessionId);
    const knownSendCounts = [await sesSentLast24h(), await sentThisMonth()];
    let interrupted = false;
    if (loss === "claim-ack-before-post") redis.pipeline = async commands => {
      const result = await originalPipeline(commands);
      if (!interrupted && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === claim) {
        interrupted = true; throw new Error("Synthetic SET ACK lost before any provider POST");
      }
      return result;
    };
    else amazonLosesReply = () => "throw";
    let first: Awaited<ReturnType<typeof confirmPurchase>>;
    try {first=await confirmPurchase(auditStore,sessionId,session);} finally {redis.pipeline=originalPipeline;amazonLosesReply=()=>null;}
    const afterFirst = {claim:redis.run(["GET",claim]),consumer:redis.run(["GET",confirmationKey(sessionId)]),amazon:amazon.length,resend:resend.length};
    const second=await confirmPurchase(auditStore,sessionId,session);
    const afterSecond = {claim:redis.run(["GET",claim]),consumer:redis.run(["GET",confirmationKey(sessionId)]),amazon:amazon.length,resend:resend.length};
    is(`${loss}: the first unacknowledged operation reports failure`, first, "failed");
    is(`${loss}: no consumer confirmation is committed on unknown acknowledgement`, afterFirst.consumer, null);
    is(`${loss}: the existing claim remains sticky`, [afterFirst.claim, afterSecond.claim], ["1", "1"]);
    is(`${loss}: the replay never adds a provider POST`, [afterFirst.amazon, afterFirst.resend, afterSecond.amazon, afterSecond.resend], loss === "claim-ack-before-post" ? [0, 0, 0, 0] : [1, 0, 1, 0]);
    is(`${loss}: a replay cannot manufacture the consumer's sent marker`, afterSecond.consumer, null);
    is(`${loss}: unknown acceptance must not become consumer sent`, second, "failed");
    is(`${loss}: a held replay does not add a known-send counter`, [await sesSentLast24h(), await sentThisMonth()], knownSendCounts);
  }

  account = approved(); askAgain(); clear();
  const knownSessionId = "cs_test_" + "c".repeat(24);
  const knownSession = auditPaid(knownSessionId);
  is("a confirmed purchase still commits its own sent marker", [await confirmPurchase(auditStore, knownSessionId, knownSession), redis.run(["GET", confirmationKey(knownSessionId)])], ["sent", "sent"]);
  is("a replay with that confirmed consumer marker is already done", await confirmPurchase(auditStore, knownSessionId, knownSession), "already");
  is("confirmed consumer replay adds no provider dispatch", [amazon.length, resend.length], [1, 0]);

  part("An uncertain individual SES acknowledgement never triggers another sender");
  for (const loss of ["throw", 500, 503] as const) {
    for (const keyed of [true, false]) {
      account = approved();
      askAgain();
      clear();
      const name = `${loss}, ${keyed ? "keyed" : "without key"}`;
      const key = `receipt:uncertain-ses:${loss}:${keyed}`;
      const claim = `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
      const counted = [await sesSentLast24h(), await sentThisMonth()];
      let deletes = 0;
      redis.pipeline = async (commands) => {
        if (commands.some((command) => command[0] === "DEL" && command[1] === claim)) deletes += 1;
        return originalPipeline(commands);
      };
      amazonLosesReply = () => loss;
      try {
        is(`${name}: actual single sender reports no confirmed acceptance`,
          await sendEmail({ ...letter("uncertain-ses@example.com"), ...(keyed ? { idempotencyKey: key } : {}) }), false);
      } finally {
        amazonLosesReply = () => null;
        redis.pipeline = originalPipeline;
      }
      is(`${name}: one possible acceptance, no second SES attempt or Resend fallback`,
        [amazon.length, resend.length, deletes], [1, 0, 0]);
      is(`${name}: an existing once-only claim is retained`, redis.run(["GET", claim]), keyed ? "1" : null);
      is(`${name}: unknown acceptance is not counted as a known send`,
        [await sesSentLast24h(), await sentThisMonth()], counted);
    }
  }
  // Existing normal sends, confirmed throttling retries and refusal fallback
  // below remain controls; this unit does not certify later unkeyed retries
  // or the separate batch sender's delivery/idempotency behavior.

  part("Unreadable batch marker evidence releases nobody to either sender");
  let markerGetters = 0;
  let oversizedMembers = 0;
  const markerCases: [string, () => unknown, number?][] = [
    ["missing envelope", () => undefined],
    ["not an array", () => ({ 0: "1", length: 1 })],
    ["empty", () => []],
    ["sparse", () => new Array(1)],
    ["inherited", () => Object.setPrototypeOf(new Array(1), { 0: "1" })],
    ["getter", () => Object.defineProperty(new Array(1), "0", { get() { markerGetters += 1; return null; } })],
    ["undefined member", () => [undefined]],
    ["empty marker", () => [""]],
    ["unexpected marker", () => [true]],
    ["symbol", () => [Symbol("1")]],
    ["oversized", () => new Proxy(["1", null], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") oversizedMembers += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["million positions", () => new Proxy(new Array(1_000_000), {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") oversizedMembers += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["lost reply", () => { throw new Error("synthetic marker read response lost"); }],
    ["later unknown", () => [null, undefined], 2],
  ];
  for (const [name, answer, count = 1] of markerCases) {
    account = approved();
    askAgain();
    clear();
    const batchKey = `bc:unknown-markers:${name}`;
    const messages = Array.from({ length: count }, (_, i) => letter(`marker${i}@example.com`));
    const markers = messages.map(m => `nl:ses:did:${createHash("sha256").update(`${batchKey}\n${m.to}`).digest("hex").slice(0, 40)}`);
    await originalPipeline(markers.map(key => ["SET", key, "1", "EX", 2 * 86_400]));
    const counted = [await sesSentLast24h(), await sentThisMonth()];
    let reads = 0;
    let deletes = 0;
    redis.pipeline = async (commands) => {
      if (commands.some(command => command[0] === "DEL" && markers.includes(String(command[1])))) deletes += 1;
      const reply = await originalPipeline(commands);
      if (commands.length === messages.length && commands.every(command => command[0] === "GET" && markers.includes(String(command[1])))) {
        reads += 1;
        return answer() as unknown[];
      }
      return reply;
    };
    try {
      is(`${name}: actual batch remains retryable without sending`,
        await sendBatch(messages, batchKey, { by: "company" }), "retry");
    } finally {
      redis.pipeline = originalPipeline;
    }
    is(`${name}: one existing read, neither sender or marker deletion`,
      [reads, amazon.length, resend.length, deletes], [1, 0, 0, 0]);
    is(`${name}: committed marker evidence stays intact`, markers.map(key => redis.run(["GET", key])), markers.map(() => "1"));
    is(`${name}: no known-send counter changes`, [await sesSentLast24h(), await sentThisMonth()], counted);
  }
  is("marker getters and members outside the requested cardinality are not read", [markerGetters, oversizedMembers], [0, 0]);
  clear();
  const markerControlKey = "bc:own-marker-control";
  const existingMarker = `nl:ses:did:${createHash("sha256").update(`${markerControlKey}\nmarker-old@example.com`).digest("hex").slice(0, 40)}`;
  await originalPipeline([["SET", existingMarker, "1", "EX", 2 * 86_400]]);
  is("own marker and explicit absence keep only the unsent recipient eligible",
    await sendBatch([letter("marker-old@example.com"), letter("marker-new@example.com")], markerControlKey, { by: "company" }), "sent");
  is("the valid positive control sends only the absent recipient", [amazon.map(m => m.to), resend.length], [["marker-new@example.com"], 0]);
  const fullWindow = Array.from({ length: 100 }, (_, i) => letter(`full-marker${i}@example.com`));
  is("all 100 existing batch positions remain available with confirmed absence",
    (await notYetTaken("bc:full-marker-window", fullWindow))?.length, 100);

  part("Unreadable handoff evidence selects neither sender");
  for (const [name, answer] of markerCases) {
    account = approved();
    askAgain();
    clear();
    const batchKey = `bc:unknown-handoff:${name}`;
    const handed = `nl:ses:rest:${createHash("sha256").update(batchKey).digest("hex").slice(0, 40)}`;
    await originalPipeline([["SET", handed, "1", "EX", 2 * 86_400]]);
    const counted = [await sesSentLast24h(), await sentThisMonth()];
    let reads = 0;
    let mutations = 0;
    redis.pipeline = async (commands) => {
      if (commands.some(command => command[1] === handed && command[0] !== "GET")) mutations += 1;
      const reply = await originalPipeline(commands);
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === handed) {
        reads += 1;
        return answer() as unknown[];
      }
      return reply;
    };
    try {
      is(`${name}: unknown handoff returns retry without choosing a sender`,
        await sendBatch([letter("handoff@example.com")], batchKey, { by: "company" }), "retry");
    } finally {
      redis.pipeline = originalPipeline;
    }
    is(`${name}: one existing handoff read, no provider call or marker mutation`,
      [reads, amazon.length, resend.length, mutations, redis.run(["GET", handed])], [1, 0, 0, 0, "1"]);
    is(`${name}: unknown handoff is not counted as a known send`,
      [await sesSentLast24h(), await sentThisMonth()], counted);
  }
  is("handoff getters and oversized reply members are not evaluated", [markerGetters, oversizedMembers], [0, 0]);
  for (const handedBefore of [false, true]) {
    account = approved();
    askAgain();
    clear();
    const batchKey = `bc:handoff-control:${handedBefore}`;
    const handed = `nl:ses:rest:${createHash("sha256").update(batchKey).digest("hex").slice(0, 40)}`;
    if (handedBefore) await originalPipeline([["SET", handed, "1", "EX", 2 * 86_400]]);
    is(`${handedBefore}: explicit handoff evidence preserves the known provider`,
      await sendBatch([letter("handoff-control@example.com")], batchKey, { by: "company" }), "sent");
    is(`${handedBefore}: exactly the selected provider accepts`,
      [amazon.length, resend.length], handedBefore ? [0, 1] : [1, 0]);
  }

  part("A new provider handoff needs its own exact acknowledgement");
  let handoffGetters = 0, handoffOutside = 0;
  const handoffWrites: [string, () => unknown][] = [
    ["undefined", () => undefined], ["null", () => null],
    ["non-array", () => ({ 0: "OK", length: 1 })], ["empty", () => []],
    ["sparse", () => new Array(1)],
    ["inherited", () => Object.setPrototypeOf(new Array(1), { 0: "OK" })],
    ["accessor", () => Object.defineProperty(new Array(1), "0", { get() { handoffGetters += 1; return "OK"; } })],
    ["null-member", () => [null]], ["wrong-member", () => [true]],
    ["symbol", () => [Symbol("OK")]],
    ["extra", () => new Proxy(["OK", "extra"], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") handoffOutside += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["lost", () => { throw new Error("synthetic handoff acknowledgement lost"); }],
  ];
  for (const applied of [false, true]) for (const [name, answer] of handoffWrites) {
    account = approved({ ProductionAccessEnabled: false });
    askAgain(); clear();
    const batchKey = `bc:handoff-write:${applied}:${name}`;
    const handed = `nl:ses:rest:${createHash("sha256").update(batchKey).digest("hex").slice(0, 40)}`;
    const counted = [await sesSentLast24h(), await sentThisMonth()];
    let writes = 0, deletes = 0;
    redis.pipeline = async commands => {
      if (commands.some(command => command[0] === "DEL" && command[1] === handed)) deletes += 1;
      if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === handed) {
        writes += 1;
        if (applied) await originalPipeline(commands);
        return answer() as unknown[];
      }
      return originalPipeline(commands);
    };
    try {
      is(`${applied}/${name}: unknown handoff never posts to either sender`,
        [await sendBatch([letter("handoff-write@example.com")], batchKey, { by: "company" }), amazon.length, resend.length],
        ["retry", 0, 0]);
    } finally { redis.pipeline = originalPipeline; }
    is(`${applied}/${name}: one write and no destructive recovery`, [writes, deletes, redis.run(["GET", handed])], [1, 0, applied ? "1" : null]);
    is(`${applied}/${name}: uncertain write grants no known send count`, [await sesSentLast24h(), await sentThisMonth()], counted);
    // Amazon is now available, but a committed handoff still owns the choice.
    account = approved(); askAgain(); clear();
    is(`${applied}/${name}: the next invocation follows actual stored evidence`,
      await sendBatch([letter("handoff-write@example.com")], batchKey, { by: "company" }), "sent");
    is(`${applied}/${name}: exactly one provider sends`, [amazon.length, resend.length], applied ? [0, 1] : [1, 0]);
    is(`${applied}/${name}: an applied handoff stays retained`, redis.run(["GET", handed]), applied ? "1" : null);
  }
  is("handoff acknowledgement getters and excess members never execute", [handoffGetters, handoffOutside], [0, 0]);
  account = approved({ ProductionAccessEnabled: false }); askAgain(); clear();
  const acknowledgedHandoffKey = "bc:handoff-write:own-ok-control";
  is("a confirmed own OK permits the first fallback",
    await sendBatch([letter("handoff-ok@example.com")], acknowledgedHandoffKey, { by: "company" }), "sent");
  is("confirmed fallback chooses Resend once", [amazon.length, resend.length], [0, 1]);
  account = approved(); askAgain();

  part("Unknown SES daily usage never grants a batch or changes provider");
  let usageGetters = 0;
  let usageOutside = 0;
  const usageRow = (value: unknown) => {
    const rows = Array<unknown>(25).fill(null);
    rows[24] = value;
    return rows;
  };
  const usageCases: [string, () => unknown][] = [
    ["missing envelope", () => undefined],
    ["not an array", () => ({ length: 25, 0: "10" })],
    ["empty envelope", () => []],
    ["short envelope", () => Array(24).fill(null)],
    ["sparse envelope", () => new Array(25)],
    ["inherited member", () => {
      const rows = Array(25).fill(null);
      delete rows[24];
      return Object.setPrototypeOf(rows, { 24: "10" });
    }],
    ["getter", () => Object.defineProperty(Array(25).fill(null), "24", { get() { usageGetters += 1; return null; } })],
    ["missing member", () => usageRow(undefined)],
    ["empty string", () => usageRow("")],
    ["boolean", () => usageRow(true)],
    ["symbol", () => usageRow(Symbol("10"))],
    ["numeric instead of stored text", () => usageRow(10)],
    ["negative", () => usageRow("-1")],
    ["fraction", () => usageRow("1.5")],
    ["leading zero", () => usageRow("01")],
    ["whitespace", () => usageRow(" 1")],
    ["non-finite", () => usageRow("Infinity")],
    ["unsafe integer", () => usageRow("9007199254740992")],
    ["unsafe sum", () => {
      const rows = usageRow("1");
      rows[0] = String(Number.MAX_SAFE_INTEGER);
      return rows;
    }],
    ["oversized", () => new Proxy(Array(26).fill(null), {
      getOwnPropertyDescriptor(target, key) {
        if (key !== "length") usageOutside += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["huge envelope", () => new Proxy(new Array(1_000_000), {
      getOwnPropertyDescriptor(target, key) {
        if (key !== "length") usageOutside += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    })],
    ["lost read reply", () => { throw new Error("synthetic existing daily usage read lost"); }],
  ];
  const usageKey = `nl:ses:h:${new Date().toISOString().slice(0, 13)}`;
  const oldUsage = redis.run(["GET", usageKey]);
  await originalPipeline([["SET", usageKey, "10", "EX", 26 * 3_600]]);
  for (const [name, answer] of usageCases) {
    account = approved();
    askAgain();
    clear();
    const counted = await sentThisMonth();
    let reads = 0;
    redis.pipeline = async (commands) => {
      const reply = await originalPipeline(commands);
      if (commands.length === 25 && commands.every(command => command[0] === "GET" && String(command[1]).startsWith("nl:ses:h:"))) {
        reads += 1;
        return answer() as unknown[];
      }
      return reply;
    };
    try {
      is(`${name}: missing daily usage remains unknown`, await sesSentLast24h(), null);
      is(`${name}: the list admission grants no capacity`, await senderRoom(), 0);
      is(`${name}: the actual batch waits before either sender`,
        await sendBatch([letter("daily-evidence@example.com")], `bc:daily-evidence:${name}`, { by: "company" }), "retry");
    } finally {
      redis.pipeline = originalPipeline;
    }
    is(`${name}: each existing call reads exactly the 25-position pipeline`, reads, 3);
    is(`${name}: neither provider accepted and the stored usage remains`,
      [amazon.length, resend.length, redis.run(["GET", usageKey]), await sentThisMonth()], [0, 0, "10", counted]);
  }
  is("usage getters and out-of-cardinality members were not evaluated", [usageGetters, usageOutside], [0, 0]);
  await originalPipeline([["DEL", usageKey], ["HSET", usageKey, "unexpected", "10"]]);
  is("a wrong-type hourly bucket is unknown, never known zero", await sesSentLast24h(), null);
  is("wrong-type hourly evidence grants no list capacity", await senderRoom(), 0);
  if (oldUsage === null) await originalPipeline([["DEL", usageKey]]);
  else await originalPipeline([["SET", usageKey, String(oldUsage), "EX", 26 * 3_600]]);
  const usageAt = Date.UTC(2032, 0, 15, 12);
  const usageKeys = Array.from({ length: 25 }, (_, i) => `nl:ses:h:${new Date(usageAt - i * 3_600_000).toISOString().slice(0, 13)}`);
  is("25 explicitly absent hourly buckets are known zero", await sesSentLast24h(usageAt), 0);
  await originalPipeline(usageKeys.map((key, i) => ["SET", key, String(i + 1), "EX", 26 * 3_600]));
  is("all 25 explicit stored counters contribute, including the last", await sesSentLast24h(usageAt), 325);
  await originalPipeline(usageKeys.map((key, i) => ["SET", key, i === 24 ? String(Number.MAX_SAFE_INTEGER) : "0", "EX", 26 * 3_600]));
  is("the last position can hold the largest exactly represented safe total", await sesSentLast24h(usageAt), Number.MAX_SAFE_INTEGER);


  part("Missing or malformed account quota is never unlimited permission");
  const badQuota: [string, unknown][] = [
    ["missing", undefined], ["empty", {}],
    ["zero maximum", { Max24HourSend: 0, MaxSendRate: 14 }],
    ["unknown negative", { Max24HourSend: -2, MaxSendRate: 14 }],
    ["string maximum", { Max24HourSend: "50000", MaxSendRate: 14 }],
    ["null maximum", { Max24HourSend: null, MaxSendRate: 14 }],
    ["boolean maximum", { Max24HourSend: true, MaxSendRate: 14 }],
    ["unsafe maximum", { Max24HourSend: Number.MAX_SAFE_INTEGER + 1, MaxSendRate: 14 }],
    ["zero rate", { Max24HourSend: 50_000, MaxSendRate: 0 }],
    ["negative rate", { Max24HourSend: 50_000, MaxSendRate: -1 }],
    ["unsupported sub-one rate", { Max24HourSend: 50_000, MaxSendRate: 0.5 }],
    ["string rate", { Max24HourSend: 50_000, MaxSendRate: "14" }],
    ["null rate", { Max24HourSend: 50_000, MaxSendRate: null }],
    ["unsafe rate", { Max24HourSend: 50_000, MaxSendRate: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing maximum", { MaxSendRate: 14 }],
    ["missing rate", { Max24HourSend: 50_000 }],
  ];
  for (const [name, quota] of badQuota) {
    account = approved({ SendQuota: quota });
    askAgain();
    clear();
    is(`${name}: essential email keeps its existing fallback`, await sendEmail(letter("quota-proof@example.com")), true);
    is(`${name}: no SES send was authorized`, [amazon.length, resend.length, (await sesState())?.ready, (await sesState())?.why], [0, 1, false, "quota"]);
  }
  for (const status of [undefined, "UNKNOWN"]) {
    account = approved({ EnforcementStatus: status });
    askAgain();
    clear();
    is(`unconfirmed enforcement ${String(status)}: existing fallback`, await sendEmail(letter("status-proof@example.com")), true);
    is(`unconfirmed enforcement ${String(status)}: no SES authorization`, [amazon.length, resend.length, (await sesState())?.why], [0, 1, "status"]);
  }

  for (const payload of [null, [], "not an account object"]) {
    account = payload as unknown as Record<string, unknown>;
    askAgain();
    clear();
    is("a non-object account response retains essential fallback", await sendEmail(letter("account-shape@example.com")), true);
    is("a non-object account response cannot authorize SES", [amazon.length, resend.length, (await sesState())?.why], [0, 1, "status"]);
  }

  part("Malformed cached quota cannot renew SES permission");
  const quotaCache = { ready: true, why: "", rate: 14, max24: 50_000, at: Math.floor(Date.now() / 1000), hold: 0 };
  const badCache: [string, Record<string, unknown>][] = [
    ["zero quota", { max24: 0 }], ["string quota", { max24: "50000" }],
    ["string rate", { rate: "14" }], ["zero rate", { rate: 0 }],
    ["unknown negative quota", { max24: -2 }], ["unsafe quota", { max24: Number.MAX_SAFE_INTEGER + 1 }],
    ["string timestamp", { at: String(quotaCache.at) }], ["negative hold", { hold: -1 }],
    ["unsafe timestamp", { at: Number.MAX_SAFE_INTEGER + 1 }], ["contradictory status", { why: "shutdown" }],
  ];
  for (const [name, fields] of badCache) {
    redis.run(["SET", "nl:ses:state", JSON.stringify({ ...quotaCache, ...fields })]);
    account = 500;
    clear();
    is(`${name}: cache cannot authorize a send while account is unreadable`, await sendEmail(letter("cache-quota@example.com")), true);
    is(`${name}: fallback only, without invented SES capacity`, [amazon.length, resend.length], [0, 1]);
  }

  part("Unconfirmed cache envelopes do not invoke getters or ask the account");
  const quotaPipeline = redis.pipeline;
  let quotaGetterCalls = 0;
  const quotaComputed = new Array(1);
  Object.defineProperty(quotaComputed, "0", { get: () => { quotaGetterCalls += 1; return JSON.stringify(quotaCache); } });
  const quotaInherited = new Array(1);
  Object.setPrototypeOf(quotaInherited, { 0: JSON.stringify(quotaCache) });
  try {
    for (const [name, reply] of [
      ["empty", []], ["extra", [JSON.stringify(quotaCache), null]], ["sparse", new Array(1)],
      ["computed", quotaComputed], ["inherited", quotaInherited], ["not array", {}],
    ] as [string, unknown][]) {
      account = approved();
      clear();
      const askedBefore = asked;
      redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === "nl:ses:state" ? reply as unknown[] : quotaPipeline.call(redis, commands);
      is(`${name}: essential email remains available`, await sendEmail(letter("cache-envelope@example.com")), true);
      is(`${name}: no unproved SES send or extra account read`, [amazon.length, resend.length, asked], [0, 1, askedBefore]);
    }
    is("cached quota getters were not invoked", quotaGetterCalls, 0);
  } finally {
    redis.pipeline = quotaPipeline;
  }

  part("Only the documented minus-one sentinel is unlimited");
  for (const [name, extra, max, rate] of [
    ["known quota", {}, 50_000, 100],
    ["documented unlimited", { SendQuota: { Max24HourSend: -1, MaxSendRate: 14 } }, -1, 14],
    ["recognized probation", { EnforcementStatus: "PROBATION" }, 50_000, 100],
    ["supported decimal rate", { SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14.5 } }, 50_000, 14.5],
  ] as [string, Record<string, unknown>, number, number][]) {
    account = approved(extra);
    askAgain();
    clear();
    is(`${name}: confirmed capability still sends through SES`, await sendEmail(letter("known-quota@example.com")), true);
    const knownQuota = await sesState();
    is(`${name}: exact quota evidence retained`, [amazon.length, resend.length, knownQuota?.max24, knownQuota?.rate], [1, 0, max, rate]);
  }
  is("zero daily quota is zero room, not infinity", await sesBulkRoom({ ...quotaCache, max24: 0 }), 0);
  is("only explicit documented minus one yields unbounded daily room", await sesBulkRoom({ ...quotaCache, max24: -1 }), Number.POSITIVE_INFINITY);
  for (const raw of [undefined, null, "50000", -2, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    is(`unproved direct quota ${String(raw)} grants no room`, await sesBulkRoom({ ...quotaCache, max24: raw as number }), null);
  }
  account = approved();
  askAgain();
  clear();



  part("An uncertain existing owner-notice read sends no email");
  const claimPipeline = redis.pipeline;
  const ownerNoticeKey = `nl:sender:${new Date().toISOString().slice(0, 7)}:told`;
  let noticeGetterCalls = 0;
  const computedNotice = new Array(1);
  Object.defineProperty(computedNotice, "0", { get: () => { noticeGetterCalls += 1; return "OK"; } });
  const inheritedNotice = new Array(1);
  Object.setPrototypeOf(inheritedNotice, { 0: "OK" });
  try {
    for (const [name, reply] of [
      ["empty", []], ["already written", ["1"]], ["boolean", [true]], ["lowercase", ["ok"]],
      ["extra", ["OK", "OK"]], ["computed", computedNotice], ["inherited", inheritedNotice],
      ["lost acknowledgement", new Error("synthetic applied owner claim reply lost")],
    ] as [string, unknown][]) {
      redis.run(["DEL", ownerNoticeKey]);
      clear();
      const askedBefore = asked;
      redis.pipeline = async commands => {
        if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === sentKey()) return [];
        if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === ownerNoticeKey) {
          if (reply instanceof Error) throw reply;
          return reply as unknown[];
        }
        return claimPipeline.call(redis, commands);
      };
      is(`${name}: unconfirmed notice claim keeps list admission held`, await reserveDay(1), false);
      is(`${name}: no provider email or account query is authorized`, [amazon.length, resend.length, asked], [0, 0, askedBefore]);
      is(`${name}: an unknown read creates no notice mark`, (await claimPipeline.call(redis, [["GET", ownerNoticeKey]]))[0], null);
    }
    is("owner-notice claim getters were never invoked", noticeGetterCalls, 0);
  } finally {
    redis.pipeline = claimPipeline;
  }

  part("The bounded owner notice describes quota evidence honestly");
  const noticePipeline = redis.pipeline;
  const noticeCases = [
    { name: "documented no daily ceiling, usage unknown", max: -1, usage: null, want: 1 },
    { name: "known daily ceiling, usage unknown", max: 50_000, usage: null, want: 1 },
    { name: "known monthly ceiling met", max: 50_000, usage: String(listCeiling()), want: listCeiling() + 50_000 },
  ];
  try {
    for (const sample of noticeCases) {
      account = approved({ SendQuota: { Max24HourSend: sample.max, MaxSendRate: 14 } });
      askAgain();
      const sampleKey = `nl:sender:${new Date().toISOString().slice(0, 7)}:told`;
      redis.run(["DEL", sampleKey, `nl:ses:once:${createHash("sha256").update(sampleKey).digest("hex").slice(0, 40)}`]);
      clear();
      redis.pipeline = async commands => commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === sentKey()
        ? sample.usage === null ? [] : [sample.usage]
        : noticePipeline.call(redis, commands);
      is(`${sample.name}: list admission remains held`, await reserveDay(sample.want), false);
      const notice = amazon.find(m => m.to === SUPPORT);
      const content = notice?.body.Content as { Simple?: { Body?: { Text?: { Data?: string } } } } | undefined;
      const words = content?.Simple?.Body?.Text?.Data ?? "";
      is(`${sample.name}: canonical subject does not assert a changing diagnosis`, notice?.subject,
        "List email is waiting for Amazon SES");
      is(`${sample.name}: no numeric quota or current usage is embedded`,
        [words.includes("50,000"), words.includes("40,000"), words.includes("allows -1"), words.includes("14 emails per second")], [false, false, false, false]);
      is(`${sample.name}: unknown capacity waits for confirmation`, words.includes("Sending waits until availability can be confirmed."), true);
      is(`${sample.name}: lists retain their SES-only route`, words.includes("Creator list email sends only through Amazon SES."), true);
      is(`${sample.name}: fallback proof requirements are explicit`, words.includes("Missing proof blocks that route."), true);
      is(`${sample.name}: no paid-plan change is prescribed from unknown evidence`, words.includes("move the sender to a larger plan"), false);
      is(`${sample.name}: essential route remains explicit`,
        words.includes("Sign-in links, receipts and deliveries keep their existing sending route"), true);
      await reserveDay(sample.want);
      await reserveDay(sample.want);
      is(`${sample.name}: the existing once-a-month notice bound is unchanged`,
        [amazon.filter(m => m.to === SUPPORT).length, resend.length], [1, 0]);
    }
  } finally {
    redis.pipeline = noticePipeline;
  }
  account = approved();
  askAgain();
  clear();


  part("A failed account refresh never renews old SES permission");
  const refreshRealNow = Date.now;
  let refreshAhead = 0;
  Date.now = () => refreshRealNow() + refreshAhead;
  try {
    for (const loss of ["server", "network"] as const) {
      const cached = { ready: true, why: "", rate: 14, max24: 50_000, at: Math.floor(Date.now() / 1000) - 301, hold: 0 };
      redis.run(["SET", "nl:ses:state", JSON.stringify(cached)]);
      account = 500;
      accountLosesReply = loss === "network";
      clear();
      const askedBefore = asked;
      is(`${loss}: essential email uses its existing fallback`, await sendEmail(letter("refresh-service@example.com")), true);
      is(`${loss}: an expired positive cache is not permission to dispatch`,
        [amazon.length, resend.length, asked], [0, 1, askedBefore + 1]);
      const stopped = await sesState();
      is(`${loss}: the same existing cache records unavailable authority`,
        [stopped?.ready, stopped?.why, stopped?.max24, stopped?.rate], [false, "unreachable", 50_000, 14]);
      refreshAhead += 30_000;
      is(`${loss}: a service batch also keeps its existing fallback`,
        await sendBatch([letter("refresh-batch@example.com")], `service:refresh:${loss}`, { by: "company" }), "sent");
      const used = await sentThisMonth();
      if (used === null) throw new Error("synthetic sender usage unavailable");
      is(`${loss}: old SES room is not added to list admission`, await senderRoom(), Math.max(0, listCeiling() - used));
      is(`${loss}: the existing minute backoff makes no extra account query`,
        [amazon.length, resend.length, asked], [0, 2, askedBefore + 1]);

      refreshAhead += 31_000;
      accountLosesReply = false;
      account = approved({ SendQuota: { Max24HourSend: 1_000, MaxSendRate: 2 } });
      is(`${loss}: fresh confirmed account evidence resumes SES automatically`,
        await sendEmail(letter("refresh-restored@example.com")), true);
      const restored = await sesState();
      is(`${loss}: only the newly confirmed lower quota is used`,
        [amazon.length, resend.length, asked, restored?.ready, restored?.max24, restored?.rate], [1, 2, askedBefore + 2, true, 1_000, 2]);
    }

    part("The existing five-minute confirmed cache interval is preserved");
    account = 500;
    accountLosesReply = false;
    redis.run(["SET", "nl:ses:state", JSON.stringify({ ready: true, why: "", rate: 14, max24: 50_000, at: Math.floor(Date.now() / 1000) - 299, hold: 0 })]);
    clear();
    const beforeFreshCache = asked;
    is("still-current confirmed capability does not query the account on every email",
      await sendEmail(letter("current-cache@example.com")), true);
    is("the existing freshness window is unchanged", [amazon.length, resend.length, asked], [1, 0, beforeFreshCache]);
    refreshAhead += 2_000;
    is("after that window a failed refresh holds SES and retains essential fallback",
      await sendEmail(letter("expired-cache@example.com")), true);
    is("no stale positive dispatch after failed refresh", [amazon.length, resend.length, asked], [1, 1, beforeFreshCache + 1]);
  } finally {
    Date.now = refreshRealNow;
    accountLosesReply = false;
  }
  account = approved();
  askAgain();
  clear();

  part("Cached SES authority needs a possible clock and no sending hold");
  for (const [label, offset, sendingHold] of [
    ["future minute", 60, 0],
    ["future five minutes", 300, 0],
    ["far future", 86_400, 0],
    ["contradictory ready hold", 0, 600],
  ] as const) {
    const seconds = Math.floor(Date.now() / 1000);
    redis.run(["SET", "nl:ses:state", JSON.stringify({
      ready: true, why: "", rate: 14, max24: 50_000,
      at: seconds + offset, hold: sendingHold ? seconds + sendingHold : 0,
    })]);
    account = 500;
    clear();
    const before = asked;
    is(`${label}: essential delivery retains its existing fallback`,
      await sendEmail(letter(`clock-${offset}-${sendingHold}@example.com`)), true);
    is(`${label}: impossible cached authority never dispatches SES`,
      [amazon.length, resend.length, asked], [0, 1, before + 1]);
    const stopped = await sesState();
    is(`${label}: failure remains unavailable with the existing backoff`,
      [stopped?.ready, stopped?.why, asked], [false, "unreachable", before + 1]);
    account = approved({ SendQuota: { Max24HourSend: 1_000, MaxSendRate: 2 } });
    askAgain();
    clear();
    is(`${label}: a new confirmed answer can restore essential SES delivery`,
      await sendEmail(letter("clock-restored@example.com")), true);
    is(`${label}: only the newly confirmed capability authorizes sending`,
      [amazon.length, resend.length, asked, (await sesState())?.max24], [1, 0, before + 2, 1_000]);
  }
  const beforeInvalidClock = asked;
  for (const impossible of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_VALUE]) {
    is("an impossible caller clock cannot authorize or query SES", await sesState(impossible), null);
  }
  is("invalid clock does not amplify account queries", asked, beforeInvalidClock);
  account = approved();
  askAgain();
  clear();

  part("A batch, one email at a time");
  clear();
  const thirty = Array.from({ length: 30 }, (_, i) => ({ ...letter(`reader${i}@example.com`, "News"), tags: { [STORE_TAG]: "a".repeat(32), [LIST_TAG]: "b".repeat(32) } }));
  is("taken", await sendBatch(thirty, "bc:1:0", { by: "company" }), "sent");
  is("all thirty by Amazon, each once", [amazon.length, new Set(amazon.map((a) => a.to)).size, resend.length], [30, 30, 0]);
  is("each carrying whose email it is, for the day one bounces", amazon[0].body.EmailTags, [{ Name: STORE_TAG, Value: "a".repeat(32) }, { Name: LIST_TAG, Value: "b".repeat(32) }]);
  is("the same batch tried again writes to nobody", [await sendBatch(thirty, "bc:1:0", { by: "company" }), amazon.length, resend.length], ["sent", 30, 0]);

  part("No faster than Amazon allows");
  account = approved({ SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14 } });
  askAgain();
  clear();
  const began = Date.now();
  const twenty = Array.from({ length: 20 }, (_, i) => letter(`pace${i}@example.com`));
  is("twenty at fourteen a second", await sendBatch(twenty, "bc:pace", { by: "company" }), "sent");
  is("take two seconds' worth of turns, and all arrive", [Date.now() - began >= 900, amazon.length], [true, 20]);

  part("Too many a second, for a moment");
  account = approved();
  askAgain();
  clear();
  let tries = 0;
  amazonSays = () => {
    tries += 1;
    return tries === 1 ? { status: 429, type: "TooManyRequestsException", message: "Maximum sending rate exceeded." } : { status: 200 };
  };
  is("a sign-in link waits its turn", await sendEmail(letter("hurry@example.com", "Your login link")), true);
  is("and still goes through Amazon", [amazon.length, resend.length, tries], [1, 0, 2]);
  amazonSays = () => ({ status: 200 });


  part("A confirmed temporary SES batch refusal still retries");
  clear();
  let batchTries = 0;
  amazonSays = () => {
    batchTries += 1;
    return batchTries === 1
      ? { status: 429, type: "TooManyRequestsException", message: "Maximum sending rate exceeded." }
      : { status: 200 };
  };
  is("a known rate refusal keeps the existing second round",
    [await sendBatch([letter("batch-busy@example.com")], "bc:confirmed-busy", { by: "company" }), batchTries, amazon.length, resend.length],
    ["sent", 2, 1, 0]);
  amazonSays = () => ({ status: 200 });

  part("An uncertain SES batch stops before retry or fallback");
  for (const loss of ["throw", 500] as const) {
    account = approved({ SendQuota: { Max24HourSend: 50_000, MaxSendRate: 2 } });
    askAgain();
    clear();
    amazonLosesReply = to => to === "batch-unknown@example.com" ? loss : null;
    const prefix = loss === "throw" ? "lost" : "server";
    const messages = [
      letter("batch-confirmed@example.com"),
      letter("batch-unknown@example.com"),
      letter("batch-not-attempted@example.com"),
    ];
    is(`${prefix}: the real sender reports an unresolved batch`,
      await sendBatch(messages, `bc:uncertain:${prefix}`, { by: "company" }), "retry");
    is(`${prefix}: one wave only, with no repeat or other provider`,
      [amazon.map(m => m.to), resend.length],
      [["batch-confirmed@example.com", "batch-unknown@example.com"], 0]);
    const pending = await notYetTaken(`bc:uncertain:${prefix}`, messages);
    is(`${prefix}: only confirmed acceptance gets the existing completion marker`,
      pending?.map(m => m.to), ["batch-unknown@example.com", "batch-not-attempted@example.com"]);
    amazonLosesReply = () => null;
  }
  account = approved();
  askAgain();
  clear();

  part("Amazon pauses the account");
  clear();
  amazonSays = () => ({ status: 400, type: "AccountSuspendedException", message: "Sending paused for this account." });
  is("a sign-in link is sent all the same", await sendEmail(letter("buyer@example.com", "Your login link")), true);
  is("through Resend, in the same breath", [amazon.length, resend.filter((m) => m.to === "buyer@example.com").length], [0, 1]);
  is("the site's own inbox is told, through Resend", resend.filter((m) => m.to === SUPPORT).map((m) => m.subject), ["Amazon SES is not sending: check the account"]);
  const held = await sesState();
  is("Amazon is left alone for ten minutes", [held?.ready, (held?.hold ?? 0) - Math.floor(Date.now() / 1000) > HOLD_SECONDS - 5], [false, true]);
  tries = 0;
  amazonSays = () => {
    tries += 1;
    return { status: 400, type: "AccountSuspendedException" };
  };
  await sendEmail(letter("next@example.com"));
  await sendBatch([letter("x@example.com"), letter("y@example.com")], "bc:held", { by: "company" });
  is("so the emails after it go straight to Resend, and the inbox is not told twice", [tries, resend.filter((m) => m.to === SUPPORT).length, resend.filter((m) => m.to !== SUPPORT).length], [0, 1, 4]);

  part("Amazon stops halfway through a batch");
  account = approved({ SendQuota: { Max24HourSend: 50_000, MaxSendRate: 5 } });
  askAgain();
  redis.run(["DEL", `nl:ses:told:${new Date().toISOString().slice(0, 10)}`]);
  clear();
  // The first five are taken; from the sixth on, the account is paused.
  amazonSays = () => (amazon.length >= 5 ? { status: 400, type: "SendingPausedException", message: "paused" } : { status: 200 });
  const twelve = Array.from({ length: 12 }, (_, i) => letter(`half${i}@example.com`, "News"));
  is("the batch still counts as sent", await sendBatch(twelve, "bc:half", { by: "company" }), "sent");
  const everyone = [...amazon.map((a) => a.to), ...resend.filter((m) => m.to !== SUPPORT).map((m) => m.to)];
  is("five by Amazon, seven by Resend", [amazon.length, resend.filter((m) => m.to !== SUPPORT).length], [5, 7]);
  is("everyone once, nobody twice", [everyone.length, new Set(everyone).size], [12, 12]);
  is("the seven under a key of their own, not the batch's", resend.find((m) => m.to !== SUPPORT)?.key !== "bc:half", true);
  amazonSays = () => ({ status: 200 });
  askAgain();
  account = approved();
  const before = [amazon.length, resend.length];
  is("and the whole batch tried again writes to nobody, though Amazon is back", [await sendBatch(twelve, "bc:half", { by: "company" }), amazon.length, resend.length], ["sent", ...before]);

  part("An email Amazon will not take for its own sake");
  clear();
  amazonSays = (to) => (to === "odd@example.com" ? { status: 400, type: "BadRequestException", message: "Illegal address" } : { status: 200 });
  is("alone, it is tried with the other sender", [await sendEmail(letter("odd@example.com")), amazon.length, resend.map((m) => m.to)], [true, 0, ["odd@example.com"]]);
  clear();
  is("in a batch, it does not hold up the others", [await sendBatch([letter("fine1@example.com"), letter("odd@example.com"), letter("fine2@example.com")], "bc:odd", { by: "company" }), amazon.map((a) => a.to), resend.length], ["sent", ["fine1@example.com", "fine2@example.com"], 0]);
  is("and Amazon is not left alone over it", (await sesState())?.ready, true);
  amazonSays = () => ({ status: 200 });

  part("Amazon's day");
  redis.clear();
  resendKeys.clear();
  account = approved({ SendQuota: { Max24HourSend: 100, MaxSendRate: 100 } });
  clear();
  is("room for list email is four fifths of Amazon's day, on top of Resend's month", await senderRoom(), listCeiling() + 80);
  const fifty = (n: number) => Array.from({ length: 50 }, (_, i) => letter(`day${n}-${i}@example.com`));
  await sendBatch(fifty(1), "bc:day:1", { by: "company" });
  is("fifty fit, and go by Amazon", [amazon.length, resend.length, await senderRoom()], [50, 0, listCeiling() + 30]);
  await sendBatch(fifty(2), "bc:day:2", { by: "company" });
  is("fifty more do not: they go by Resend, whole, rather than wait", [amazon.length, resend.length], [50, 50]);
  is("and the rest of Amazon's day is still there for a sign-in link", [await sendEmail(letter("buyer@example.com", "Your login link")), amazon.length, resend.length], [true, 51, 50]);


  part("List-only mail waits for SES without using the service fallback");
  redis.clear(); resendKeys.clear(); clear();
  const savedRole = process.env.AWS_SES_ROLE_ARN;
  delete process.env.AWS_SES_ROLE_ARN;
  is("missing SES leaves list recipients waiting without either sender",
    [await sendListBatch([letter("list-missing@example.com")], "list:missing", { by: "monthly" }), amazon.length, resend.length],
    ["waiting", 0, 0]);
  process.env.AWS_SES_ROLE_ARN = savedRole;
  account = approved({ SendingEnabled: false }); askAgain();
  is("a paused account is known waiting, not unknown acceptance",
    [await sendListBatch([letter("list-paused@example.com")], "list:paused", { by: "monthly" }), amazon.length, resend.length],
    ["waiting", 0, 0]);
  is("the existing Amazon-only probe contract still says retry",
    await sendBatch([letter("probe-paused@example.com")], "list:probe", { by: "company" }, "amazon"), "retry");
  is("service email still uses its default fallback",
    [await sendEmail(letter("service-paused@example.com")), amazon.length, resend.filter(m => m.to === "service-paused@example.com").length],
    [true, 0, 1]);
  redis.clear(); resendKeys.clear(); clear();
  account = approved({ SendQuota: { Max24HourSend: 0, MaxSendRate: 100 } });
  is("no SES daily room cannot authorize a list Resend send",
    [await sendListBatch([letter("list-day@example.com")], "list:day", { by: "monthly" }), amazon.length, resend.length],
    ["waiting", 0, 0]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  is("confirmed SES capacity sends the actual list batch",
    [await sendListBatch([letter("list-healthy@example.com")], "list:healthy", { by: "monthly" }), amazon.map(m => m.to), resend.length],
    ["sent", ["list-healthy@example.com"], 0]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  amazonSays = () => ({ status: 400, type: "AccountSuspendedException", message: "Sending paused" });
  is("a rejection after a send attempt remains held",
    await sendListBatch([letter("list-refused@example.com")], "list:refused", { by: "monthly" }), "retry");
  is("the list recipient never reaches Resend", resend.filter(m => m.to !== SUPPORT).length, 0);
  is("the owner notice does not claim the list mail was delivered",
    resend.filter(m => m.to === SUPPORT).map(m => m.subject), ["Amazon SES is not sending: check the account"]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  amazonSays = () => ({ status: 400, type: "BadRequestException", message: "Synthetic confirmed recipient refusal" });
  // Rule 23 (claude5/broadcast-refused-recipient): was "refused" for the whole batch. Amazon's words are about the
  // recipient, so it is that address's refusal, reported as such and never "sent"; nothing reaches Resend.
  is("a known recipient refusal cannot be called a sent list",
    [await sendListBatch([letter("list-rejected@example.com")], "list:rejected", { by: "monthly" }), amazon.length, resend.length],
    [{ refused: [{ to: "list-rejected@example.com", address: true }] }, 0, 0]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  amazonSays = () => ({ status: 400, type: "MessageRejected", message: "Synthetic confirmed content refusal" });
  is("an email refused as it is, for nobody taken, is still the batch's refusal",
    [await sendListBatch([letter("list-content@example.com"), letter("list-content-2@example.com")], "list:content", { by: "monthly" }), amazon.length, resend.length],
    ["refused", 0, 0]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  amazonSays = to => to === "list-bad@example.com" ? { status: 400, type: "BadRequestException", message: "Synthetic confirmed refusal" } : { status: 200 };
  const mixedList = [letter("list-good@example.com"), letter("list-bad@example.com")];
  // Rule 23 (claude5/broadcast-refused-recipient): was "retry". With every email answered and the accepted one's did
  // mark read back, the batch is a known partial: the refused one is named, never "sent", and nothing is replayed.
  is("partial acceptance with its did mark read back names the refused one rather than holding or replaying",
    await sendListBatch(mixedList, "list:mixed", { by: "monthly" }), { refused: [{ to: "list-bad@example.com", address: false }] });
  is("the held partial batch has one accepted recipient and no fallback",
    [amazon.map(m => m.to), resend.length], [["list-good@example.com"], 0]);
  redis.clear(); resendKeys.clear(); clear(); account = approved();
  amazonSays = () => ({ status: 200 });
  amazonLosesReply = to => to === "list-unknown@example.com" ? 500 : null;
  is("unknown SES acceptance never becomes safe waiting or fallback",
    [await sendListBatch([letter("list-unknown@example.com")], "list:unknown", { by: "monthly" }), amazon.length, resend.length],
    ["retry", 1, 0]);
  amazonLosesReply = () => null; account = approved();

  part("Amazon does not answer");
  account = 500;
  askAgain();
  clear();
  is("email goes through Resend", [await sendEmail(letter("buyer@example.com")), amazon.length, resend.length], [true, 0, 1]);
  const askedDown = asked;
  await sendEmail(letter("buyer2@example.com"));
  is("and Amazon is asked again in a minute, not on every email", asked, askedDown);
  account = 403;
  askAgain();
  is("a key Amazon does not believe is an answer: not usable", [(await sesState())?.ready, (await sesState())?.why], [false, "key"]);

  part("One original identity before sender awaits, with the legacy structural contract");
  const identityClaim = (key: string) => `nl:ses:once:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  redis.clear(); clear(); account = approved();
  const entryKey = "identity-before-meter-await-A", laterKey = "identity-before-meter-await-B";
  redis.run(["SET", identityClaim(entryKey), "1", "EX", 86_400]);
  const entryMessage = { ...letter("entry@example.test"), idempotencyKey: entryKey };
  const entryPending = sendEmail(entryMessage);
  entryMessage.idempotencyKey = laterKey;
  is("capture precedes the first sender await, including metering", [await entryPending, amazon.length, resend.length, redis.run(["GET", identityClaim(laterKey)])], [false, 0, 0, null]);
  let rejectedIdentityReads = 0;
  const rejectedMessage = Object.defineProperty(letter("not-an-address"), "idempotencyKey", { get() { rejectedIdentityReads += 1; return entryKey; } });
  is("synchronous recipient refusal does not evaluate identity", [await sendEmail(rejectedMessage), rejectedIdentityReads], [false, 0]);
  for (const fallback of [false, true]) {
    for (const changing of [false, true]) {
      redis.clear(); clear();
      account = fallback ? approved({ ProductionAccessEnabled: false }) : approved();
      const a = `identity-snapshot-${fallback}-${changing}-A`;
      const b = `identity-snapshot-${fallback}-${changing}-B`;
      if (!fallback) redis.run(["SET", identityClaim(a), "1", "EX", 86_400]);
      const message = { ...letter("identity@example.test"), idempotencyKey: a };
      const pipeline = redis.pipeline;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      let paused = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      redis.pipeline = async (commands) => {
        if (!paused && commands.some((command) => command[0] === "GET" && command[1] === "nl:ses:state")) {
          paused = true; entered(); await gate;
        }
        return pipeline(commands);
      };
      try {
        const pending = sendEmail(message);
        await Promise.race([waiting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Synthetic readiness gate not reached")), 3_000); })]);
        if (changing) message.idempotencyKey = b;
        release();
        const result = await pending;
        is(`readiness ${fallback ? "fallback" : "SES"}, ${changing ? "mutated" : "fixed"}: original identity retained`,
          [result, amazon.length, resend.length, redis.run(["GET", identityClaim(b)]), resend[0]?.key ?? null],
          fallback ? [true, 0, 1, null, a] : [false, 0, 0, null, null]);
      } finally {
        release(); if (timer) clearTimeout(timer); redis.pipeline = pipeline;
      }
    }
  }
  for (const fallback of [false, true]) {
    redis.clear(); clear();
    account = fallback ? approved({ ProductionAccessEnabled: false }) : approved();
    const a = `identity-accessor-${fallback}-A`, b = `identity-accessor-${fallback}-B`;
    if (!fallback) redis.run(["SET", identityClaim(a), "1", "EX", 86_400]);
    let reads = 0;
    const message = Object.defineProperty(letter("getter@example.test"), "idempotencyKey", { get() { return ++reads === 1 ? a : b; } });
    const result = await sendEmail(message);
    is(`legacy getter is read once for ${fallback ? "fallback" : "SES"}`,
      [result, reads, amazon.length, resend.length, redis.run(["GET", identityClaim(b)]), resend[0]?.key ?? null],
      fallback ? [true, 1, 0, 1, null, a] : [false, 1, 0, 0, null, null]);
  }
  for (const [name, value] of [["missing", undefined], ["undefined", undefined], ["null", null], ["empty", ""], ["whitespace", "  "], ["long", "k".repeat(512)]] as const) {
    redis.clear(); clear(); account = approved();
    const message = { ...letter("identity-compat@example.test"), ...(name === "missing" ? {} : { idempotencyKey: value }) };
    is(`compatible SES identity ${name}`, [await sendEmail(message as Parameters<typeof sendEmail>[0]), amazon.length, resend.length], [true, 1, 0]);
  }
  redis.clear(); clear(); account = approved();
  const inheritedKey = "identity-inherited-original";
  redis.run(["SET", identityClaim(inheritedKey), "1", "EX", 86_400]);
  const inheritedMessage = Object.assign(Object.create({ idempotencyKey: inheritedKey }), letter("inherited@example.test"));
  is("inherited legacy identity remains respected", [await sendEmail(inheritedMessage), amazon.length, resend.length], [false, 0, 0]);

  delete process.env.AWS_SES_ROLE_ARN;
  delete process.env.VERCEL_OIDC_TOKEN;
  exchanges.length = 0;
  part("With a role, no key of Amazon's is kept anywhere");
  redis.clear();
  resendKeys.clear();
  account = approved();
  clear();
  delete process.env.AWS_SES_ACCESS_KEY_ID;
  delete process.env.AWS_SES_SECRET_ACCESS_KEY;
  is("with neither a role nor a key, Amazon is not there", isSesConfigured(), false);
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/marktmorgen-email";
  is("the role alone is enough: nothing secret among the settings", [isSesConfigured(), sesConfig()?.roleArn, sesConfig()?.key], [true, "arn:aws:iam::123456789012:role/marktmorgen-email", null]);
  is("a request the host gave no token is sent through Resend", [await sendEmail(letter("buyer@example.com")), amazon.length, resend.length, exchanges.length], [true, 0, 1, 0]);
  is("and Amazon is marked as not usable for want of a key", (await sesState())?.why, "key");

  // The host puts its token on each request it serves, where its own helper reads it.
  const hostGives = (token: string) => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] = { get: () => ({ headers: { "x-vercel-oidc-token": token } }) };
  };
  hostGives("aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl");
  askAgain();
  clear();
  // The minute Amazon is left alone after a refusal has passed.
  const realNow = Date.now;
  let ahead = 61_000;
  Date.now = () => realNow() + ahead;
  is("with the host's token, the next one is sent", await sendEmail(letter("buyer@example.com", "Your login link")), true);
  is("through Amazon", [amazon.length, resend.length], [1, 0]);
  is("after one exchange: the token for the role, and nothing else", exchanges, [{ role: "arn:aws:iam::123456789012:role/marktmorgen-email", token: "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl", action: "AssumeRoleWithWebIdentity" }]);
  const lentHeaders = amazon[0].headers;
  is("signed with the key Amazon lent, and carrying its session", [/Credential=ASIAEXAMPLELENT1\//.test(lentHeaders.authorization), lentHeaders["x-amz-security-token"], /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/.test(lentHeaders.authorization)], [true, "session-token-1", true]);
  await sendBatch([letter("a@example.com"), letter("b@example.com"), letter("c@example.com")], "bc:role", { by: "company" });
  is("the same lent key serves the emails after it", [amazon.length, exchanges.length], [4, 1]);
  ahead += 56 * 60_000;
  stsAnswersXml = true;
  await sendEmail(letter("later@example.com"));
  is("near the end of its hour another is borrowed, read from either of Amazon's two answers", [amazon.length, exchanges.length, amazon[4].headers["x-amz-security-token"]], [5, 2, "session-token-2"]);
  stsAnswersXml = false;

  part("A role that does not trust this project");
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/somebody-elses";
  stsRefuses = true;
  askAgain();
  clear();
  is("the email is sent all the same", await sendEmail(letter("buyer@example.com", "Your login link")), true);
  is("through Resend, and Amazon is not asked for a key on every email", [amazon.length, resend.length, exchanges.length], [0, 1, 3]);
  await sendEmail(letter("buyer2@example.com"));
  is("nor asked again within the minute", exchanges.length, 3);
  stsRefuses = false;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/marktmorgen-email";
  Date.now = realNow;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")];
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-baseline";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";

  part("Amazon tells us an email bounced");
  redis.clear();
  account = approved();
  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings("owner@example.com", { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail("owner@example.com"))!;
  const list = store.listId as string;
  for (const who of ["gone", "angry", "fine"]) await upsertContact(list, `${who}@example.com`, { agreed: true, explicit: true, source: "import" }, ROOM);
  const tags = { "ses:configuration-set": ["marktmorgen"], [STORE_TAG]: [healthId(store)], [LIST_TAG]: [list] };
  const bounce = (to: string, type = "Permanent") => ({ eventType: "Bounce", bounce: { bounceType: type, bounceSubType: "General", bouncedRecipients: [{ emailAddress: to, status: "5.1.1" }] }, mail: { destination: [to], tags } });
  fetched.length = 0;
  const heard = await POST(announce({ event: bounce("gone@example.com") }));
  is("believed, with Amazon's signature from our topic", [heard.status, await heard.json()], [200, { ok: true, result: "counted" }]);
  is("the certificate was read from Amazon's own host", fetched, [`https://sns.${REGION}.amazonaws.com/SimpleNotificationService-abc.pem`]);
  is("the address is off the list, and counted for the store", [await isMailable(list, "gone@example.com"), (await listHealth(healthId(store))).bounced], [false, 1]);
  const spam = await POST(announce({ SignatureVersion: "1", event: { eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] }, mail: { tags } } }));
  is("a spam report is heard the same way, under the older signature too", [(await spam.json()).result, await isMailable(list, "angry@example.com"), (await listHealth(healthId(store))).complained], ["counted", false, 1]);
  const soft = await POST(announce({ event: bounce("fine@example.com", "Transient") }));
  is("a bounce that may yet deliver takes nobody off", [(await soft.json()).result, await isMailable(list, "fine@example.com")], ["ignored", true]);
  is("a delivery, or anything else, is acknowledged and left", await (await POST(announce({ event: { eventType: "Delivery", mail: { tags } } }))).json(), { ok: true });

  part("Only Amazon, and only our topic");
  const refused = async (request: NextRequest) => [(await POST(request)).status, await isMailable(list, "fine@example.com")];
  is("a signature that does not match", await refused(announce({ event: bounce("fine@example.com") }, { sign: false })), [401, true]);
  is("somebody else's topic, signed by Amazon all the same", await refused(announce({ TopicArn: `arn:aws:sns:${REGION}:999999999999:not-ours`, event: bounce("fine@example.com") })), [401, true]);
  fetched.length = 0;
  is("a certificate from anywhere but Amazon", await refused(announce({ SigningCertURL: "https://sns.us-east-1.amazonaws.com.example.net/cert.pem", event: bounce("fine@example.com") })), [401, true]);
  is("is not even fetched", fetched, []);
  is("an announcement two hours old", await refused(announce({ Timestamp: new Date(Date.now() - 2 * 3_600_000).toISOString(), event: bounce("fine@example.com") })), [401, true]);
  const twice = announce({ MessageId: "sns-same", event: bounce("fine@example.com") });
  const body = await twice.clone().text();
  await POST(twice);
  const repeat = new NextRequest("https://marktmorgen.com/api/mail/ses", { method: "POST", headers: { host: "marktmorgen.com", "content-length": String(Buffer.byteLength(body)) }, body });
  is("the same announcement again is acted on once", [await (await POST(repeat)).json(), (await listHealth(healthId(store))).bounced], [{ ok: true }, 2]);

  part("Amazon asks whether we want the topic's announcements");
  fetched.length = 0;
  const link = `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=abc`;
  const yes = await POST(announce({ Type: "SubscriptionConfirmation", Token: "abc", SubscribeURL: link, Message: "You have chosen to subscribe" }));
  is("answered yes, by opening Amazon's own link", [yes.status, (await yes.json()).result, fetched.includes(link)], [200, "confirmed", true]);
  fetched.length = 0;
  const elsewhere = await POST(announce({ Type: "SubscriptionConfirmation", Token: "abc", SubscribeURL: "https://example.net/confirm", Message: "You have chosen to subscribe" }));
  is("a link anywhere else is not opened", [elsewhere.status, fetched.filter((u) => u.includes("example.net"))], [400, []]);

  part("Owner notices record acceptance only after the real sender accepts");
  const dailyNotice = `nl:ses:told:${new Date().toISOString().slice(0, 10)}`;
  const monthlyNotice = `nl:sender:${new Date().toISOString().slice(0, 7)}:told`;
  const acceptedKey = process.env.RESEND_API_KEY;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/marktmorgen-email";
  const originalNoticeFetch = globalThis.fetch;
  const originalNoticePipeline = redis.pipeline;
  const notices: [string, string, () => Promise<unknown>][] = [
    ["SES down", dailyNotice, () => sendEmail(letter("notice-trigger@example.test"))],
    ["general sender", monthlyNotice, () => reserveDay(1)],
    ["list-only sender", monthlyNotice, () => reserveMail(store, 1, true)],
  ];
  try {
    for (const [purpose, marker, trigger] of notices) {
      const setup = () => {
        redis.clear(); clear(); resendKeys.clear();
        account = approved();
        amazonSays = () => ({ status: 400, type: "AccountSuspendedException", message: "synthetic paused" });
        if (purpose !== "SES down") {
          account = approved({ ProductionAccessEnabled: false });
          redis.run(["SET", sentKey(), String(listCeiling())]);
        }
      };
      // Deliberately unregistered: synthetic refusal, not proof of production NULL policy.
      setup(); process.env.RESEND_API_KEY = "re_SYNTHETIC_NOTICE_UNREVIEWED_ONLY";
      await trigger(); await trigger();
      is(`${purpose}: refused fallback consumes no notice mark`, [redis.run(["GET", marker]), amazon.length, resend.length], [null, 0, 0]);
      process.env.RESEND_API_KEY = acceptedKey;
      setup();
      const beforePosts: unknown[] = [];
      globalThis.fetch = (async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "api.resend.com" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if (body.to?.[0] === SUPPORT) beforePosts.push(redis.run(["GET", marker]));
        }
        return originalNoticeFetch(input, init);
      }) as typeof fetch;
      await trigger();
      is(`${purpose}: marker absent at provider POST, written after acceptance`, [beforePosts, redis.run(["GET", marker])], [[null], "1"]);
      await trigger();
      is(`${purpose}: confirmed notice mark skips subsequent owner email`, resend.filter(m => m.to === SUPPORT).length, 1);
      const notice = resend.find(m => m.to === SUPPORT);
      is(`${purpose}: sender has a stable purpose/period identity`, notice?.key, marker);
      for (const outcome of ["rejected", "uncertain"] as const) {
        setup();
        let attempted = 0;
        globalThis.fetch = (async (input, init) => {
          const url = new URL(String(input));
          if (url.hostname === "api.resend.com" && init?.method === "POST" && JSON.parse(String(init.body)).to?.[0] === SUPPORT) {
            attempted += 1;
            is(`${purpose}/${outcome}: no mark before POST`, redis.run(["GET", marker]), null);
            if (outcome === "rejected") return new Response(JSON.stringify({ message: "synthetic rejection" }), { status: 422 });
            await originalNoticeFetch(input, init);
            throw new TypeError("synthetic provider ACK lost after acceptance");
          }
          return originalNoticeFetch(input, init);
        }) as typeof fetch;
        await trigger(); await trigger();
        is(`${purpose}/${outcome}: no acceptance mark`, redis.run(["GET", marker]), null);
        is(`${purpose}/${outcome}: uncertain acceptance cannot dispatch twice`, resend.filter(m => m.to === SUPPORT).length, outcome === "uncertain" ? 1 : 0);
        is(`${purpose}/${outcome}: provider was exercised`, attempted > 0, true);
      }
      globalThis.fetch = originalNoticeFetch;
      let noticeReadGetters = 0;
      const accessorRead = Object.defineProperty(new Array(1), "0", { get() { noticeReadGetters += 1; return null; } });
      const inheritedRead = Object.setPrototypeOf(new Array(1), { 0: null });
      for (const reply of [[], ["1"], [undefined], [true], [null, null], new Array(1), accessorRead, inheritedRead, new Error("synthetic notice read lost")]) {
        setup();
        redis.pipeline = async commands => {
          if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === marker) {
            if (reply instanceof Error) throw reply;
            return reply;
          }
          return originalNoticePipeline.call(redis, commands);
        };
        await trigger();
        is(`${purpose}: existing or unknown marker read holds owner notice`, [resend.filter(m => m.to === SUPPORT).length, redis.run(["GET", marker])], [0, null]);
        redis.pipeline = originalNoticePipeline;
      }
      is(`${purpose}: notice reads never invoke getters`, noticeReadGetters, 0);
      setup();
      await Promise.all([trigger(), trigger()]);
      is(`${purpose}: concurrent notices share provider identity`, resend.filter(m => m.to === SUPPORT).map(m => m.key), [marker]);
      setup();
      redis.pipeline = async commands => {
        if (commands.some(c => c[0] === "SET" && c[1] === marker)) throw Error("synthetic mark persistence unavailable after ACK");
        return originalNoticePipeline.call(redis, commands);
      };
      await trigger(); await trigger();
      is(`${purpose}: lost marker persistence retains sender deduplication`, [redis.run(["GET", marker]), resend.filter(m => m.to === SUPPORT).map(m => m.key)], [null, [marker]]);
      redis.pipeline = originalNoticePipeline;
      globalThis.fetch = originalNoticeFetch;
      setup();
      const retryBodies: string[] = [];
      globalThis.fetch = (async (input, init) => {
        if (new URL(String(input)).hostname === "api.resend.com" && init?.method === "POST" && JSON.parse(String(init.body)).to?.[0] === SUPPORT) retryBodies.push(String(init.body));
        return originalNoticeFetch(input, init);
      }) as typeof fetch;
      redis.pipeline = async commands => {
        if (commands.some(c => c[0] === "SET" && c[1] === marker)) throw Error("synthetic marker failed after provider acceptance");
        return originalNoticePipeline.call(redis, commands);
      };
      await trigger();
      is(`${purpose}: accepted sender with lost marker still has no notice mark`, redis.run(["GET", marker]), null);
      redis.pipeline = originalNoticePipeline;
      // Change every formerly interpolated diagnosis. Monthly retry also
      // changes between list-only and general admission, under the same key.
      if (purpose === "SES down") {
        askAgain(); account = approved();
        amazonSays = () => ({ status: 400, type: "AccountSuspendedException", message: "different synthetic account reason" });
        await trigger();
      } else if (purpose === "list-only sender") await reserveDay(1);
      else await reserveMail(store, 1, true);
      is(`${purpose}: canonical retry recovers existing receipt and records mark`, [redis.run(["GET", marker]), retryBodies.length, resend.filter(m => m.to === SUPPORT).length], ["1", 1, 1]);
      globalThis.fetch = originalNoticeFetch;
      setup();
      let rejectOnce = true;
      const rejectedBodies: string[] = [];
      globalThis.fetch = (async (input, init) => {
        if (new URL(String(input)).hostname === "api.resend.com" && init?.method === "POST" && JSON.parse(String(init.body)).to?.[0] === SUPPORT) {
          rejectedBodies.push(String(init.body));
          if (rejectOnce) { rejectOnce = false; return new Response(JSON.stringify({ message: "synthetic known rejection" }), { status: 422 }); }
        }
        return originalNoticeFetch(input, init);
      }) as typeof fetch;
      await trigger();
      is(`${purpose}: known rejection leaves the period unspent`, redis.run(["GET", marker]), null);
      if (purpose === "SES down") { askAgain(); account = approved(); }
      await trigger();
      is(`${purpose}: rejected key is not cached and the next acceptance records the period`, [redis.run(["GET", marker]), rejectedBodies.length, rejectedBodies[0] === rejectedBodies[1], resend.filter(m => m.to === SUPPORT).length], ["1", 2, true, 1]);
      globalThis.fetch = originalNoticeFetch;
    }
  } finally {
    redis.pipeline = originalNoticePipeline; globalThis.fetch = originalNoticeFetch;
    process.env.RESEND_API_KEY = acceptedKey; amazonSays = () => ({ status: 200 });
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
