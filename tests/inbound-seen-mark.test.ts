/**
 * Rule 24 (CX-123): app/api/mail/inbound must not lose an announcement it failed to act on.
 *
 * Each Resend announcement is acted on once: its svix-id is marked as seen. One that could not be
 * acted on (a refused send, a report that could not be recorded) is answered 500 so Resend retries.
 * Before this test the mark was taken for a whole day up front and let go of with a DEL whose reply
 * was never read: when that DEL did not land (an empty or unknown pipeline reply, a thrown error, or
 * the function stopped before reaching it), every retry was answered { ok: true } and the support
 * message was never sent on, or the complaint never recorded. The same happened to a retry that
 * came in while the first try was still running and that try then failed.
 *
 * Kept: a genuine duplicate of an announcement that was acted on is still acknowledged and ignored,
 * for the whole day, and a retry after a clean let-go is heard at once. Synthetic data only; no
 * real provider is called.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { STORE_TAG, listHealth } from "@/lib/mail-health";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
/** Resend's second retry comes five minutes after its first (resend.com/docs/webhooks/retries-and-replays). */
const RESEND_SECOND_RETRY_MS = 5 * 60 * 1000;
const HEALTH = "0123456789abcdef0123456789abcdef";

let failSending = false;
let sent = 0;
let holdSend: Promise<void> | null = null;
let reachedSend: () => void = () => {};
const mail = (id: string) => ({ object: "email", id, from: "jane@example.com", to: ["support@marktmorgen.com"], received_for: ["support@marktmorgen.com"], reply_to: [], subject: "Refund for my order", text: "Hello.", headers: { from: "Jane Doe <jane@example.com>" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    if (holdSend) {
      reachedSend();
      await holdSend;
    }
    if (failSending) return new Response("{}", { status: 429 });
    sent += 1;
    return new Response(JSON.stringify({ id: "e" }));
  }
  if (url.hostname === "api.resend.com") {
    if (/\/attachments$/.test(url.pathname)) return new Response(JSON.stringify({ object: "list", has_more: false, data: [] }));
    const one = url.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (one) return new Response(JSON.stringify(mail(one[1])));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function announce(id: string, type: string, data: Record<string, unknown>): NextRequest {
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, created_at: "2026-10-03T00:00:00.000Z", data });
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,${signature}` },
    body,
  });
}
const received = (id: string, emailId: string) => announce(id, "email.received", { email_id: emailId, from: "x", to: ["y"], subject: "z" });
const complained = (id: string, to: string) => announce(id, "email.complained", { to: [to], tags: [{ name: STORE_TAG, value: HEALTH }] });
const emailIdOf = (n: number) => `4ef9a417-02e9-4d39-ad75-${String(n).padStart(12, "0")}`;

const real = redis.pipeline.bind(redis);
const isDelOfSeen = (commands: (string | number)[][]) => commands[0]?.[0] === "DEL" && String(commands[0][1]).startsWith("nl:inbound:seen:");
/** The DEL that lets go of the seen mark answers `shape` (or throws, for "throws") and does not land. */
function delAnswers(shape: unknown[] | "throws", failOthers = false): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (isDelOfSeen(commands)) {
      if (shape === "throws") throw new Error("Redis request failed with status 503");
      return shape;
    }
    const key = String(commands[0]?.[1] ?? "");
    if (failOthers && !key.startsWith("nl:inbound:seen:") && !key.startsWith("nl:rl:")) throw new Error("Redis request failed with status 503");
    return real(commands);
  }) as typeof redis.pipeline;
}
const restore = () => { redis.pipeline = real; };
const isClaim = (commands: (string | number)[][]) => commands[0]?.[0] === "SET" && commands[0]?.[3] === "NX" && String(commands[0][1]).startsWith("nl:inbound:seen:");
/** The claim (SET … NX with its GET) answers `shape` and does not land: nothing proves this request holds it. */
function claimAnswers(shape: unknown[]): void {
  redis.pipeline = (async (commands: (string | number)[][]) => (isClaim(commands) ? shape : real(commands))) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  let n = 0;

  part("control: a refused send is let go of, and the retry is heard at once");
  {
    const emailId = emailIdOf(++n);
    failSending = true;
    is("refused: 500", (await POST(received("msg_ctl", emailId))).status, 500);
    failSending = false;
    const ok = await POST(received("msg_ctl", emailId));
    is("retry: sent", [ok.status, (await ok.json()).result, sent], [200, "sent", 1]);
  }

  part("control: a genuine duplicate of one acted on is acknowledged and ignored, all day");
  {
    const emailId = emailIdOf(++n);
    const before = sent;
    const first = await POST(received("msg_dup", emailId));
    is("first: sent", [first.status, (await first.json()).result, sent - before], [200, "sent", 1]);
    const again = await POST(received("msg_dup", emailId));
    is("the same one again: { ok: true }, not sent again", [again.status, await again.json(), sent - before], [200, { ok: true }, 1]);
    advance(RESEND_SECOND_RETRY_MS);
    const later = await POST(received("msg_dup", emailId));
    is("five minutes later: still { ok: true }, not sent again", [later.status, await later.json(), sent - before], [200, { ok: true }, 1]);
    advance(23 * 3_600_000);
    const lastHour = await POST(received("msg_dup", emailId));
    is("in the day's last hour: still { ok: true }, not sent again", [lastHour.status, await lastHour.json(), sent - before], [200, { ok: true }, 1]);
  }

  part("inbound message: the let-go DEL did not land");
  for (const shape of [[], [undefined], ["QUEUED"], "throws"] as (unknown[] | "throws")[]) {
    const label = JSON.stringify(shape);
    const emailId = emailIdOf(++n);
    const msg = `msg_shape_${n}`;
    const before = sent;
    failSending = true;
    delAnswers(shape);
    const failed = await POST(received(msg, emailId));
    restore();
    failSending = false;
    is(`DEL ${label}: the first try is a 500 (Resend will retry)`, failed.status, 500);
    const soon = await POST(received(msg, emailId));
    const soonBody = await soon.json();
    is(`DEL ${label}: a retry that comes at once sends nothing and is not answered ok, so Resend keeps it`, [sent - before, soon.status >= 200 && soon.status < 300 && soonBody.ok === true], [0, false]);
    advance(RESEND_SECOND_RETRY_MS);
    const retried = await POST(received(msg, emailId));
    is(`DEL ${label}: Resend's retry five minutes later is heard and the message sent on`, [retried.status, (await retried.json()).result, sent - before], [200, "sent", 1]);
  }

  part("complaint: the let-go DEL did not land");
  for (const shape of [[], ["QUEUED"], "throws"] as (unknown[] | "throws")[]) {
    const label = JSON.stringify(shape);
    const msg = `msg_complaint_${++n}`;
    const to = `reader${n}@example.com`;
    const before = (await listHealth(HEALTH)).complained;
    delAnswers(shape, true);
    const failed = await POST(complained(msg, to));
    restore();
    is(`DEL ${label}: the complaint could not be recorded, so a 500`, failed.status, 500);
    const soon = await POST(complained(msg, to));
    const soonBody = await soon.json();
    is(`DEL ${label}: a retry that comes at once is not answered ok while nothing was recorded`, [(await listHealth(HEALTH)).complained - before, soon.status >= 200 && soon.status < 300 && soonBody.ok === true], [0, false]);
    advance(RESEND_SECOND_RETRY_MS);
    const retried = await POST(complained(msg, to));
    is(`DEL ${label}: Resend's retry five minutes later records the complaint`, [retried.status, (await retried.json()).result, (await listHealth(HEALTH)).complained - before], [200, "counted", 1]);
  }

  // Codex R1 on #3261 (app/api/mail/inbound/route.ts:113-124): only an exact "OK" with the hold read
  // back proves this request won the claim; any other reply is unknown, never taken as won.
  part("the claim's reply is unknown: nothing is acted on and Resend keeps the announcement");
  for (const shape of [[], [undefined, undefined], ["QUEUED", "QUEUED"], ["OK", "1"], ["OK", null], [0, "acting"]] as unknown[][]) {
    const label = JSON.stringify(shape);
    const emailId = emailIdOf(++n);
    const msg = `msg_claim_${n}`;
    const before = sent;
    claimAnswers(shape);
    const first = await POST(received(msg, emailId));
    restore();
    const firstBody = await first.json();
    is(`claim ${label}: message not sent on and not answered ok`, [sent - before, first.status >= 200 && first.status < 300 && firstBody.ok === true], [0, false]);
    advance(RESEND_SECOND_RETRY_MS);
    const retried = await POST(received(msg, emailId));
    is(`claim ${label}: Resend's retry is heard and sent on once`, [retried.status, (await retried.json()).result, sent - before], [200, "sent", 1]);

    const cmsg = `msg_claim_complaint_${n}`;
    const to = `claim${n}@example.com`;
    const was = (await listHealth(HEALTH)).complained;
    claimAnswers(shape);
    const report = await POST(complained(cmsg, to));
    restore();
    const reportBody = await report.json();
    is(`claim ${label}: complaint not recorded and not answered ok`, [(await listHealth(HEALTH)).complained - was, report.status >= 200 && report.status < 300 && reportBody.ok === true], [0, false]);
  }

  part("a retry that comes while the first try is still running, which then fails");
  {
    const emailId = emailIdOf(++n);
    const msg = "msg_in_flight";
    const before = sent;
    let release: () => void = () => {};
    holdSend = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reachedSend = resolve; });
    failSending = true;
    const first = POST(received(msg, emailId));
    await reached;
    holdSend = null;
    const during = await POST(received(msg, emailId));
    const duringBody = await during.json();
    is("the retry during the first try sends nothing", sent - before, 0);
    is("and is not answered ok, so Resend keeps it", during.status >= 200 && during.status < 300 && duringBody.ok === true, false);
    release();
    is("the first try is then refused: 500", (await first).status, 500);
    failSending = false;
    const retried = await POST(received(msg, emailId));
    is("the next retry is heard and sent on once", [retried.status, (await retried.json()).result, sent - before], [200, "sent", 1]);
  }

  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
