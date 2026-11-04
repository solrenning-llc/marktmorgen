/**
 * The daily check of the way a bounce travels (lib/verify-mail.ts) passes
 * when the whole chain holds, and fails when any link is broken.
 *
 * The check exists because the chain runs through the senders, where no
 * test here can reach: so these stand in for the senders, faithfully enough
 * to break one link at a time — a sender that will not take the email, one
 * that announces the bounce without the tags it was given, one that
 * announces nothing — and see that the check says so. The real chain is
 * what the scheduled job runs, against the real senders, every day.
 */
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { POST as resendPosts } from "@/app/api/mail/inbound/route";
import { POST as amazonPosts } from "@/app/api/mail/ses/route";
import { TRUSTED_TOKEN } from "@/lib/ses";
import { stringToSign, type SnsMessage } from "@/lib/sns";
import { verifyAmazonAccount, verifyHostToken, verifyMailLoop, verifyProviderUsage } from "@/lib/verify-mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { withCutoff } from "@/lib/fetch-timeout";

const REGION = "us-east-1";
const TOPIC = `arn:aws:sns:${REGION}:123456789012:marktmorgen-email`;
const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

type Tag = { name: string; value: string };
/** How the stand-in for Resend behaves: as the real one, or with one link broken. */
let resend: "faithful" | "drops-tags" | "silent" | "refuses" = "faithful";
const resendTook: { to: string; tags?: Tag[] }[] = [];
const amazonTook: string[] = [];
let n = 0;

/** Resend's announcement of what became of one email, signed as it signs them. */
async function resendAnnounces(type: string, to: string, tags: Tag[] | undefined): Promise<void> {
  n += 1;
  const id = `msg_${n}`;
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: `e${n}`, to: [to], subject: "Marktmorgen delivery check", ...(type === "email.bounced" ? { bounce: { type: "Permanent", subType: "General", message: "user unknown" } } : {}), ...(tags ? { tags: Object.fromEntries(tags.map((t) => [t.name, t.value])) } : {}) },
  });
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  await resendPosts(new NextRequest("https://marktmorgen.com/api/mail/inbound", { method: "POST", headers: { host: "marktmorgen.com", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,${signature}` }, body }));
}

/** Amazon's announcement, through its topic, signed with its certificate. */
async function amazonAnnounces(event: Record<string, unknown>): Promise<void> {
  n += 1;
  const message: SnsMessage = { Type: "Notification", MessageId: `sns-${n}`, TopicArn: TOPIC, Message: JSON.stringify(event), Timestamp: new Date().toISOString(), SignatureVersion: "2", Signature: "", SigningCertURL: `https://sns.${REGION}.amazonaws.com/cert.pem` };
  message.Signature = createSign("RSA-SHA256").update(stringToSign(message), "utf8").sign(privateKey, "base64");
  const body = JSON.stringify(message);
  await amazonPosts(new NextRequest("https://marktmorgen.com/api/mail/ses", { method: "POST", headers: { host: "marktmorgen.com", "content-length": String(Buffer.byteLength(body)) }, body }));
}

let assumedRoles = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    if (resend === "refuses") return json({ name: "validation_error" }, 403);
    const batch = JSON.parse(String(init?.body)) as { to: string[]; tags?: Tag[] }[];
    for (const m of batch) {
      resendTook.push({ to: m.to[0], tags: m.tags });
      if (resend === "silent") continue;
      const type = m.to[0].startsWith("bounced") ? "email.bounced" : "email.complained";
      // A moment later, as the real one does.
      setTimeout(() => void resendAnnounces(type, m.to[0], resend === "drops-tags" ? undefined : m.tags), 50);
    }
    return json({ data: batch.map((_, i) => ({ id: `e${i}` })) });
  }
  if (url.hostname === "api.resend.com") return json({ id: "single" });
  if (url.hostname === `sts.${REGION}.amazonaws.com`) {
    const form = new URLSearchParams(String(init?.body));
    if (form.get("Action") !== "AssumeRoleWithWebIdentity" ||
        form.get("RoleArn") !== "arn:aws:iam::123456789012:role/synthetic-verify-mail" ||
        !form.get("WebIdentityToken")) return json({ message: "synthetic role refused" }, 403);
    assumedRoles += 1;
    return json({ AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: "ASIAEXAMPLEVERIFY001", SecretAccessKey: "synthetic-lent-secret-never-stored-000000", SessionToken: "synthetic-verify-session", Expiration: Math.floor(Date.now() / 1000) + 3_600 } } } });
  }
  if (url.hostname === `email.${REGION}.amazonaws.com`) {
    if (url.pathname === "/v2/email/account") return json({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14 } });
    const body = JSON.parse(String(init?.body)) as { Destination: { ToAddresses: string[] }; EmailTags?: { Name: string; Value: string }[] };
    const to = body.Destination.ToAddresses[0];
    amazonTook.push(to);
    const tags = Object.fromEntries((body.EmailTags ?? []).map((t) => [t.Name, [t.Value]]));
    const event = to.startsWith("bounce")
      ? { eventType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: to }] }, mail: { tags } }
      : { eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: to }] }, mail: { tags } };
    setTimeout(() => void amazonAnnounces(event), 50);
    return json({ MessageId: "m" });
  }
  if (url.hostname === `sns.${REGION}.amazonaws.com`) return new Response(publicKey.export({ type: "spki", format: "pem" }).toString());
  return json({}, 404);
}) as typeof fetch;

const hostGives = (claims: Record<string, unknown> | null) => {
  const key = Symbol.for("@vercel/request-context");
  if (!claims) delete (globalThis as Record<symbol, unknown>)[key];
  else {
    const part64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const token = `${part64({ alg: "RS256" })}.${part64(claims)}.c2lnbmF0dXJl`;
    (globalThis as Record<symbol, unknown>)[key] = { get: () => ({ headers: { "x-vercel-oidc-token": token } }) };
  }
};
const failing = (checks: { check: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.check);
/** What the check left behind of its made-up list, which must be nothing. */
const leftBehind = () => redis.keys().filter((k) => k.startsWith("nl:store:leads:") || k.startsWith("nl:mail:health:") || k.startsWith("nl:mail:paused:"));

async function main(): Promise<void> {
  redis.clear();
  for (const name of ["AWS_SES_ROLE_ARN", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "AWS_SES_REGION", "AWS_SES_CONFIGURATION_SET", "AWS_SES_TOPIC_ARN", "VERCEL_OIDC_TOKEN", "RESEND_WEBHOOK_SECRET"]) delete process.env[name];
  process.env.RESEND_API_KEY = "re_test_check_only_a_stand_in";

  part("The host's token");
  hostGives(null);
  is("a request with no token fails, and says so", verifyHostToken().map((c) => [c.ok, c.detail]), [[false, "this request carries no token from the host"]]);
  const soon = Math.floor(Date.now() / 1000) + 7_200;
  hostGives({ ...TRUSTED_TOKEN, exp: soon });
  is("the token Amazon is told to trust passes", verifyHostToken().map((c) => [c.ok, c.detail]), [[true, "issuer, audience and subject as in infra/amazon-ses.yml; good for 120 more minutes"]]);
  hostGives({ ...TRUSTED_TOKEN, sub: "owner:viniciussucupira:project:renamed:environment:production", exp: soon });
  is("a project renamed fails, with both names", verifyHostToken()[0], { check: "the host's token is the one Amazon is told to trust", ok: false, detail: `sub is "owner:viniciussucupira:project:renamed:environment:production", and Amazon is told "${TRUSTED_TOKEN.sub}"` });
  hostGives({ ...TRUSTED_TOKEN, exp: soon - 10_000 });
  is("a token past its time fails", verifyHostToken()[0].ok, false);
  const stack = readFileSync(join(process.cwd(), "infra/amazon-ses.yml"), "utf8");
  is("and the stack tells Amazon exactly those three", [stack.includes(`Url: ${TRUSTED_TOKEN.iss}`), stack.includes(`"oidc.vercel.com/viniciussucupira:aud": ${TRUSTED_TOKEN.aud}`), stack.includes(`"oidc.vercel.com/viniciussucupira:sub": ${TRUSTED_TOKEN.sub}`)], [true, true, true]);
  hostGives({ ...TRUSTED_TOKEN, exp: soon });

  part("Nothing set up to hear from");
  const none = await verifyMailLoop(Date.now() + 1_000);
  is("neither sender is checked, and neither is failed for it", none.map((c) => [c.check, c.ok]), [["Resend's loop", true], ["Amazon SES's loop", true]]);
  is("Amazon's account is not asked about either", await verifyAmazonAccount(), []);

  part("Resend, with every link holding");
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
  const good = await verifyMailLoop(Date.now() + 20_000);
  is("the bounce and the spam report both come back", good.slice(0, 2).map((c) => [c.check, c.ok]), [
    ["Resend: a list email's bounce comes back with its tags and takes the address off", true],
    ["Resend: a spam report comes back with its tags and takes the address off", true],
  ]);
  is("to the addresses Resend keeps for it, each with this run's label", resendTook.map((m) => m.to.replace(/\+[0-9a-f]{8}@/, "+label@")), ["bounced+label@resend.dev", "complained+label@resend.dev"]);
  is("tagged as a list email is: a store and a list, both made up", resendTook[0].tags?.map((t) => [t.name, /^[0-9a-f]{32}$/.test(t.value)]), [["nl_store", true], ["nl_list", true]]);
  is("and nothing of the made-up list is left behind", leftBehind(), []);

  part("Resend, with one link broken");
  resend = "drops-tags";
  const dropped = await verifyMailLoop(Date.now() + 4_000);
  is("announcing the bounce without the tags fails both", failing(dropped), ["Resend: a list email's bounce comes back with its tags and takes the address off", "Resend: a spam report comes back with its tags and takes the address off"]);
  resend = "silent";
  const silent = await verifyMailLoop(Date.now() + 4_000);
  is("announcing nothing fails both, and says how long it waited", [failing(silent).length, /^nothing heard in \d+s$/.test(silent[0].detail)], [2, true]);
  resend = "refuses";
  const refused = await verifyMailLoop(Date.now() + 4_000);
  is("not taking the email fails at once", refused.slice(0, 1).map((c) => [c.check, c.ok, c.detail]), [["Resend takes a list email", false, 'it answered "refused"']]);
  is("and each time the made-up list is taken away again", leftBehind(), []);
  resend = "faithful";

  part("Amazon SES, once it is sending");
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-verify-mail";
  process.env.VERCEL_OIDC_TOKEN = "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl";
  process.env.AWS_SES_REGION = REGION;
  process.env.AWS_SES_CONFIGURATION_SET = "marktmorgen";
  process.env.AWS_SES_TOPIC_ARN = TOPIC;
  is("the account answers, and is said to be sending", (await verifyAmazonAccount()).map((c) => [c.ok, c.detail]), [[true, "sending through Amazon: 50,000 emails in 24 hours, 14 a second"]]);
  is("SES account check borrows only a temporary role identity", assumedRoles, 1);
  resendTook.length = 0;
  const both = await verifyMailLoop(Date.now() + 20_000);
  is("both senders are checked, each through itself and its own address back", both.map((c) => [c.check.split(":")[0], c.ok]), [["Resend", true], ["Resend", true], ["Amazon SES", true], ["Amazon SES", true]]);
  is("Amazon's two went to Amazon's own test mailboxes, and Resend's to Resend's", [amazonTook.map((to) => to.replace(/\+[0-9a-f]{8}@/, "+label@")), resendTook.length], [["bounce+label@simulator.amazonses.com", "complaint+label@simulator.amazonses.com"], 2]);
  is("and nothing is left behind", leftBehind(), []);
  is("the existing role session serves the complete synthetic sender check", assumedRoles, 1);


  part("Read-only account observations use one exact UTC anchor without new probes");
  const readCalls: { path: string; method: string }[] = [];
  let metricsStatus = 200;
  let stallCredentials = false;
  const collectorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    readCalls.push({ path: url.pathname, method: String(init?.method) });
    if (url.hostname === `sts.${REGION}.amazonaws.com` && stallCredentials) {
      return { ok: true, status: 200, text: () => new Promise(() => {}) } as Response;
    }
    if (url.pathname === "/v2/email/account") return Response.json({
      ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 50_000, MaxSendRate: 14, SentLast24Hours: 37 },
    });
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/metrics") {
      if (metricsStatus !== 200) return new Response("", { status: metricsStatus });
      return Response.json({
        object: "metrics", start_date: url.searchParams.get("start_date"), end_date: url.searchParams.get("end_date"),
        metrics: ["sent"], dimensions: [], totals: { sent: 11 },
      });
    }
    if (url.hostname === "api.resend.com" && url.pathname === "/usage") return Response.json({
      object: "usage", emails: {
        daily: { used: 13, limit: 100, sent: 11, received: 2, resets_at: "2026-11-02T00:00:00.000Z" },
        monthly: { used: 104, limit: 50_000, sent: 80, received: 24, resets_at: "2026-11-17T15:30:00.000Z" },
      },
    });
    throw new Error(`Unexpected provider usage request: ${url.pathname}`);
  };
  const anchor = Date.now();
  const observed = await verifyProviderUsage(anchor);
  is("the exact Resend window is anchored to the collector's UTC start", observed.window, {
    from: new Date(anchor - 86_400_000).toISOString(), through: new Date(anchor).toISOString(),
  });
  is("different provider counters never assert matching snapshots or billing units",
    [observed.basis, observed.alignment], ["provider_reported_counters", {
      anchor: "collector_start_utc", exactSameWindow: false, billingUnitsComparable: false,
    }]);
  is("all three evidence sources keep their own meanings",
    [
      observed.ses.ok ? observed.ses.sentLast24Hours : null,
      observed.resend.ok ? observed.resend.sent : null,
      observed.resendAccount.ok ? observed.resendAccount.monthly.used : null,
      observed.resendAccount.ok ? observed.resendAccount.monthly.resetsAt : null,
    ], [37, 11, 104, "2026-11-17T15:30:00.000Z"]);
  is("the SES observation retains its latency bounds",
    observed.ses.ok && observed.ses.requestedAt === new Date(anchor).toISOString() &&
      Date.parse(observed.ses.observedAt) >= anchor, true);
  is("the reader makes exactly three GETs and no email, list or notification writes",
    readCalls.map(call => `${call.method} ${call.path}`).sort(),
    ["GET /emails/metrics", "GET /usage", "GET /v2/email/account"]);
  metricsStatus = 403;
  const partial = await verifyProviderUsage();
  is("read authorization failure does not erase the other provider or billing observation",
    [partial.ses.ok, partial.resend, partial.resendAccount.ok],
    [true, { ok: false, reason: "unauthorized" }, true]);
  const priorCalls = readCalls.length;
  is("an invalid anchor has no invented range or count",
    await verifyProviderUsage(Number.MAX_SAFE_INTEGER), {
      basis: "provider_reported_counters", window: null,
      alignment: { anchor: "collector_start_utc", exactSameWindow: false, billingUnitsComparable: false },
      ses: { ok: false, reason: "unknown" }, resend: { ok: false, reason: "unknown" },
      resendAccount: { ok: false, reason: "unknown" },
    });
  is("the invalid anchor made no request", readCalls.length, priorCalls);

  part("The collection deadline also bounds a stalled credential body");
  const priorRole = process.env.AWS_SES_ROLE_ARN;
  process.env.AWS_SES_ROLE_ARN = "arn:aws:iam::123456789012:role/synthetic-stalled-provider-usage";
  metricsStatus = 200;
  stallCredentials = true;
  const bounded = await withCutoff(Date.now() + 250, () => verifyProviderUsage());
  is("a credential body cannot block collection or erase successful Resend evidence",
    [bounded.ses, bounded.resend.ok, bounded.resendAccount.ok],
    [{ ok: false, reason: "provider" }, true, true]);
  process.env.AWS_SES_ROLE_ARN = priorRole;
  globalThis.fetch = collectorFetch;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
