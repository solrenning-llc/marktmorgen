/**
 * Delivery reports belong to the email, never to a recipient.  These checks
 * exercise the signed Resend route and Amazon's event reader, including the
 * distinction between a temporary and a permanent bounce.
 */
import { createHmac, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { recordSesEvent } from "@/lib/mail-report";
import { healthTags } from "@/lib/mail-health";
import { MAIL_REPORT_TAG, RECORD_MAIL_REPORT, mailReportDay, noteMailReportEvent } from "@/lib/mail-report";
import { readSesEvent } from "@/lib/sns";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import * as callbackCosts from "./plan-cost-registry";
import * as reportCheckpoint from "@/lib/mail-report";

const SECRET = Buffer.from("mail-report-events-test-secret");
const STORE = "0123456789abcdef0123456789abcdef";
const LIST = "fedcba9876543210fedcba9876543210";
const CAMPAIGN = "b-0123456789abcdef01234567";
const EVENT_AT = new Date().toISOString();
let id = 0;

function announce(type: string, data: Record<string, unknown>, sameId?: string): NextRequest {
  const eventId = sameId ?? `report_${++id}`;
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: EVENT_AT, data });
  const signature = createHmac("sha256", SECRET).update(`${eventId}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: {
      host: "marktmorgen.com",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "svix-id": eventId,
      "svix-timestamp": at,
      "svix-signature": `v1,${signature}`,
    },
    body,
  });
}

const tags = { nl_store: STORE, nl_list: LIST, [MAIL_REPORT_TAG]: CAMPAIGN };

/** Opt-in native check: MAIL_REPORT_REDIS_SERVER=/path/to/redis-server.
 * A disposable loopback subprocess only; never accepts a Redis URL/account. */
async function nativeCanonicalCounters() {
  const binary = process.env.MAIL_REPORT_REDIS_SERVER;
  if (!binary) {
    console.log("Native Redis controls not run: set MAIL_REPORT_REDIS_SERVER to a local redis-server binary.");
    return;
  }
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No disposable Redis port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const server = spawn(binary, ["--bind", "127.0.0.1", "--port", String(port), "--protected-mode", "yes", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  let startError: Error | undefined;
  server.on("error", error => { startError = error; });
  const command = (parts: (string | number)[]) => new Promise<string | number | null>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let reply = Buffer.alloc(0);
    socket.setTimeout(3_000, () => socket.destroy(new Error("Disposable Redis timeout")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`*${parts.length}\r\n${parts.map(value => { const s = String(value); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("")}`));
    socket.on("data", chunk => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf("\r\n");
      if (end < 0) return;
      const kind = reply.toString("ascii", 0, 1), value = reply.toString("utf8", 1, end);
      if (kind === "$" && Number(value) >= 0 && reply.length < end + 2 + Number(value) + 2) return;
      socket.destroy();
      if (kind === "-") reject(new Error(value));
      else if (kind === "+") resolve(value);
      else if (kind === ":") resolve(Number(value));
      else if (kind === "$") resolve(Number(value) === -1 ? null : reply.toString("utf8", end + 2, end + 2 + Number(value)));
      else reject(new Error("Unexpected disposable Redis reply"));
    });
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      if (startError) throw startError;
      ready = await command(["PING"]).then(value => value === "PONG", () => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!ready) throw new Error("Disposable Redis did not start");
    const operations = async () => String(await command(["INFO", "commandstats"])).split("\n")
      .filter(line => line.startsWith("cmdstat_") && !/^cmdstat_(info|config)(:|\|)/.test(line))
      .reduce((sum, line) => sum + Number(line.match(/calls=(\d+)/)?.[1] ?? 0), 0);
    const controlKey = `synthetic:mail-report:${randomUUID()}`;
    const control = ["EVAL", RECORD_MAIL_REPORT, 1, controlKey, "receipt", "aggregate", 1, Math.floor(Date.now() / 1000) + 60, 3];
    await command(["CONFIG", "RESETSTAT"]);
    is("native Redis accepts a canonical first outcome", await command(control), 1);
    is("native first-outcome command ceiling includes the script's internal commands", await operations(), callbackCosts.MAIL_REPORT_COST_COMPONENTS.firstOutcomeCommands);
    await command(["CONFIG", "RESETSTAT"]);
    is("native Redis confirms a valid replay", await command(control), 2);
    is("native replay cost includes validating its aggregate", await operations(), callbackCosts.MAIL_REPORT_COST_COMPONENTS.duplicateOutcomeCommands);
    for (const bad of ["01", "00000"]) {
      const key = `synthetic:mail-report:${randomUUID()}`;
      await command(["HSET", key, "aggregate", bad]);
      const evalArgs = ["EVAL", RECORD_MAIL_REPORT, 1, key, "receipt", "aggregate", 1, Math.floor(Date.now() / 1000) + 60, 3];
      is(`native Redis refuses ${bad} before any write`, await command(evalArgs).catch(() => "ERR"), -1);
      is(`native Redis leaves no receipt for ${bad}`, await command(["HGET", key, "receipt"]), null);
      is(`native Redis never confirms a replay over ${bad}`, await command(evalArgs).catch(() => "ERR"), -1);
      is(`native Redis preserves the malformed aggregate ${bad}`, await command(["HGET", key, "aggregate"]), bad);
      await command(["HSET", key, "receipt", "1"]);
      is(`native Redis refuses a previously orphaned receipt over ${bad}`, await command(evalArgs).catch(() => "ERR"), -1);
    }
  } finally {
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise<void>(resolve => server.once("exit", () => resolve()));
      server.kill("SIGTERM");
      await stopped;
    }
  }
}

async function main() {
  redis.clear();
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${SECRET.toString("base64")}`;
  part("CX-112: missing reviewed admission cannot spend on a report");
  is("the production report admission is explicitly unknown", reportCheckpoint.CURRENT_MAIL_REPORT_ADMISSION, null);
  is("the cost registry cannot claim a different admission", callbackCosts.MAIL_REPORT_COST_COMPONENTS.reviewedAdmission, reportCheckpoint.CURRENT_MAIL_REPORT_ADMISSION);
  const checkpointPipeline = redis.pipeline.bind(redis);
  const checkpointCommands: (string | number)[][] = [];
  redis.pipeline = async commands => { checkpointCommands.push(...commands); return checkpointPipeline(commands); };
  try {
    for (const outcome of ["delivered", "permanent-bounce", "temporary-bounce", "complained"] as const) {
      is(`an unreviewed ${outcome} cannot record a report`, await noteMailReportEvent(STORE, CAMPAIGN, outcome, 1, `ses:unreviewed-${outcome}`, Date.now()), false);
    }
    is("a direct report writer without admission makes zero Redis requests", checkpointCommands, []);
    is("an unavailable report is unknown, never four zero counts", await mailReportDay(STORE, CAMPAIGN), null);
    is("an unreviewed report reader also makes zero Redis requests", checkpointCommands, []);
  } finally {
    redis.pipeline = checkpointPipeline;
    redis.clear();
  }

  part("The prepared email identity and event parser do not admit writes");
  is("the report tag is shared by the email and contains no recipient", healthTags({ sid: STORE, listId: LIST }, true, CAMPAIGN), tags);
  is("a recipient cannot be a report identity", healthTags({ sid: STORE, listId: LIST }, true, "reader@example.test"), { nl_store: STORE, nl_list: LIST });
  const previousDay = new Date(Date.now() - 86_400_000).toISOString();
  for (const [kind, field] of [["Delivery", "delivery"], ["Bounce", "bounce"], ["Complaint", "complaint"], ["DeliveryDelay", "deliveryDelay"]]) {
    is(`${kind} uses its own event time, not the send time`, readSesEvent(JSON.stringify({ eventType: kind, [field]: { timestamp: EVENT_AT }, mail: { timestamp: previousDay, messageId: `ses_${kind}`, tags } }))?.occurredAt, Date.parse(EVENT_AT));
  }
  is("SES keeps the delivery recipients and shared tags", readSesEvent(JSON.stringify({ eventType: "Delivery", delivery: { timestamp: EVENT_AT, recipients: ["reader@example.test"] }, mail: { messageId: "ses_delivery_1", tags } })), { kind: "delivered", permanent: false, recipients: ["reader@example.test"], tags, messageId: "ses_delivery_1", occurredAt: Date.parse(EVENT_AT) });
  for (const kind of ["delivered", "delayed"] as const) {
    is(`an authenticated SES ${kind} remains unrecorded`, await recordSesEvent({ kind, permanent: false, recipients: ["reader@example.test"], tags, messageId: `ses_${kind}`, occurredAt: Date.now() }), null);
  }
  is("SES delivery/delay do not create any Redis key", redis.keys(), []);
  for (const type of ["email.delivered", "email.delivery_delayed"]) {
    const answer = await POST(announce(type, { email_id: type, to: ["reader@example.test"], tags }));
    is(`signed ${type} is acknowledged without claiming a recorded outcome`, [answer.status, await answer.json()], [200, { ok: true }]);
  }
  is("existing transport deduplication does not create report or health storage", redis.keys().some(key => key.startsWith("nl:mail:health:") || key.startsWith("nl:mail:paused:")), false);
  for (const bounceType of ["Transient", "Undetermined"]) {
    const event = readSesEvent(JSON.stringify({ eventType: "Bounce", bounce: { bounceType, timestamp: EVENT_AT, bouncedRecipients: [{ emailAddress: "temporary@example.test" }] }, mail: { messageId: `ses_${bounceType}`, tags } }));
    is(`${bounceType} is explicitly non-permanent`, event?.permanent, false);
    is(`${bounceType} never enters SES health protection`, event && await recordSesEvent(event), "ignored");
    const answer = await POST(announce("email.bounced", { email_id: `resend_${bounceType}`, to: ["temporary@example.test"], tags, bounce: { type: bounceType } }));
    is(`${bounceType} never enters Resend health protection`, await answer.json(), { ok: true, result: "ignored" });
  }
  is("temporary bounces never create report, suppression, recipient-health or pause keys", redis.keys().filter(key => !key.startsWith("nl:rl:mail-inbound:") && !key.startsWith("nl:inbound:seen:")), []);

  part("Existing permanent bounce and complaint protection is unchanged");
  const realNow = Date.now;
  const at = realNow();
  Date.now = () => at;
  try {
    for (const provider of ["ses", "resend"]) for (const outcome of ["permanent-bounce", "complained"] as const) {
      const observations: unknown[] = [];
      for (const withReportTag of [false, true]) {
        redis.clear();
        const dayKey = `nl:mail:health:${STORE}:${new Date(at).toISOString().slice(0, 10)}`;
        redis.run(["HSET", dayKey, "s", 1000, outcome === "complained" ? "c" : "b", outcome === "complained" ? 4 : 24]);
        const providerTags = withReportTag ? tags : { nl_store: STORE, nl_list: LIST };
        const commands: (string | number)[][] = [];
        const pipeline = redis.pipeline.bind(redis);
        redis.pipeline = async batch => { commands.push(...batch); return pipeline(batch); };
        let result: unknown;
        try {
          if (provider === "ses") result = await recordSesEvent({ kind: outcome === "complained" ? "complained" : "bounced", permanent: outcome !== "complained", recipients: ["health@example.test"], tags: providerTags, messageId: "ses_health", occurredAt: at });
          else result = (await (await POST(announce(outcome === "complained" ? "email.complained" : "email.bounced", { email_id: "resend_health", to: ["health@example.test"], tags: providerTags, bounce: { type: "Permanent" } }, "same_health_notice"))).json()).result;
        } finally { redis.pipeline = pipeline; }
        is(`${provider} ${outcome} still pauses at the existing threshold`, result, "paused");
        is(`${provider} ${outcome} has no report EVAL or four-field report read`, commands.some(command => command[0] === "EVAL" && command[1] === RECORD_MAIL_REPORT || command[0] === "HMGET" && command.slice(2).some(field => String(field).startsWith("r:"))), false);
        is(`${provider} ${outcome} adds no report field`, (redis.run(["HKEYS", dayKey]) as string[]).some(field => field.startsWith("r:")), false);
        // Rule 23: the seen mark's value is now each run's own (lib/claim-mark.ts claimValue, once-marks-owner), so it
        // differs between the two runs by design; it is compared by its shape, every other command exactly as before.
        const sameShape = commands.map((command) => command[0] === "SET" && String(command[1]).startsWith("nl:inbound:seen:") && /^\d+\.\d{9}$/.test(String(command[2]))
          ? [command[0], command[1], "a run's own value", ...command.slice(3)]
          : command);
        observations.push({ result, commands: sameShape, health: redis.run(["HGETALL", dayKey]), paused: redis.run(["GET", `nl:mail:paused:${STORE}`]) });
      }
      is(`${provider} ${outcome}: adding the prepared tag preserves every legacy command and result`, observations[1], observations[0]);
    }
  } finally { Date.now = realNow; }

  part("Every delivered email would bring its own callback bill");
  const price = callbackCosts.mailReportCallbackCost;
  const one = price(1, 1, 0.2);
  is("one delivery scenario includes its notice, invocation and eleven commands", one && [one.notices, one.invocations, one.redisCommands], [1, 1, 11]);
  is("the known sizing components have positive cost", Boolean(one && one.totalUsd > 0.0012), true);
  is("the full allowance is counted without free tier", price(10_000, 1, 0.2)?.totalUsd, one && one.totalUsd * 10_000);
  is("retries still have an invocation cost", price(1, 101, 0.2)?.invocations, 101);
  is("unknown regional transfer cannot become zero", price(1, 1, null), null);
  for (const bad of [-1, NaN, Infinity, 0.5]) is("invalid counts do not acquire a price", price(bad, 1, 0.2), null);

  part("The disconnected Lua primitive preserves its prepared invariants");
  redis.clear();
  const boundedKey = "synthetic:mail-report:bounded";
  const first = ["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt", "aggregate", 1, Math.floor(at / 1000) + 3600, 2];
  is("the exact field ceiling admits receipt and aggregate in the primitive", redis.run(first), 1);
  is("an identical primitive replay is confirmed", redis.run(first), 2);
  is("a new receipt above the ceiling is refused before writing", redis.run(["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt2", "aggregate", 1, Math.floor(at / 1000) + 3600, 2]), -1);
  is("refusal preserves both original fields", redis.run(["HGETALL", boundedKey]), ["receipt", "1", "aggregate", "1"]);
  is("a contradictory replay cannot change the count", redis.run(["EVAL", RECORD_MAIL_REPORT, 1, boundedKey, "receipt", "aggregate", 2, Math.floor(at / 1000) + 3600, 2]), -1);
  const expiresBefore = redis.run(["TTL", boundedKey]);
  redis.advance(1000);
  redis.run(first);
  is("a primitive replay never renews the original expiry", redis.run(["TTL", boundedKey]), Number(expiresBefore) - 1);
  for (const bad of ["01", "00000"]) {
    const key = `synthetic:mail-report:corrupt-${bad}`;
    redis.run(["HSET", key, "aggregate", bad]);
    const args = ["EVAL", RECORD_MAIL_REPORT, 1, key, "receipt", "aggregate", 1, Math.floor(at / 1000) + 3600, 3];
    is(`the emulator refuses ${bad} before writing`, redis.run(args), -1);
    is(`no receipt survives ${bad}`, redis.run(["HGET", key, "receipt"]), null);
    is(`a replay over ${bad} is not success`, redis.run(args), -1);
    is(`the malformed aggregate ${bad} stays unchanged`, redis.run(["HGET", key, "aggregate"]), bad);
    redis.run(["HSET", key, "receipt", "1"]);
    is(`an orphaned receipt over ${bad} cannot become success`, redis.run(args), -1);
  }
  redis.clear();
  await nativeCanonicalCounters();
  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
