/**
 * Mail written to our own support addresses is sent on through SES as a
 * company email (lib/inbound-mail.ts, forwardInbound). Until 9 November 2026
 * nothing bounded it but the webhook's per-connection limit, and the
 * connection is Resend's, not the sender's: one sender wrote support@ 300
 * times with 1 MB each and all 300 messages and 300 MB went out at the
 * company's cost (ALTO 1 of Claude 5's email audit). Spending SES's day also
 * stops buyers' receipts and sign-in links.
 *
 * Held here: a sender (however the address is written) is sent on at most
 * SUPPORT_SENDER_HOURLY times an hour and SUPPORT_SENDER_DAILY a day; all
 * senders together at most SUPPORT_DAILY a UTC day; files at most
 * SUPPORT_FILE_BYTES_DAILY bytes a UTC day. Each is counted before the send.
 * A message past a ceiling is "held": left in Resend (Emails, Receiving),
 * never retried, and the inbox is told once a day where to find it. A count
 * that cannot be read sends nothing and asks Resend to try again. A retried
 * message is counted once. The store path keeps CREATOR_HOURLY and is not
 * counted against the company's ceiling. docs/funded-exposure-review.md
 * carries the month's ceiling the registry computes.
 */
import { readFileSync } from "node:fs";
import * as inbound from "@/lib/inbound-mail";
import { installSesMailFixture } from "./ses-mail-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import * as registry from "./plan-cost-registry";

process.env.RESEND_API_KEY = "re_SYNTHETIC_TEST_ONLY";
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
process.env.RESEND_INBOUND_API_KEY = "re_SYNTHETIC_INBOUND_ONLY";
process.env.SUPPORT_FORWARD_TO = "owner@example.org";

const limits = inbound as unknown as Record<string, number | undefined>;
const HOURLY = limits.SUPPORT_SENDER_HOURLY ?? 10;
const SENDER_DAILY = limits.SUPPORT_SENDER_DAILY ?? 30;
const DAILY = limits.SUPPORT_DAILY ?? 200;
const FILE_BYTES = limits.SUPPORT_FILE_BYTES_DAILY ?? 300_000_000;
type Forward = (id: string, now?: number) => Promise<string>;
const forward = inbound.forwardInbound as unknown as Forward;

const NOON = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** What each received message looks like: its sender, where it was written, and its files' sizes. */
const messages = new Map<string, { from: string; to: string; files: number[] }>();
let fileReads = 0;
let receivingReads = 0;
let readFails = false;
const fixture = installSesMailFixture({
  onResend: (_m, input) => {
    const url = new URL(String(input));
    const att = /^\/emails\/receiving\/([0-9a-f-]+)\/attachments$/.exec(url.pathname);
    if (att) {
      const m = messages.get(att[1]);
      return json({ data: (m?.files ?? []).map((size, n) => ({ filename: `f${n}.bin`, size, download_url: `https://files.resend.com/${att[1]}/${n}` })) });
    }
    const one = /^\/emails\/receiving\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one) {
      receivingReads++;
      if (readFails) return new Response("down", { status: 503 });
      const m = messages.get(one[1]);
      if (!m) return new Response("no", { status: 404 });
      return json({ object: "email", id: one[1], from: m.from, to: [m.to], subject: "hello", text: "words", headers: {} });
    }
    return undefined;
  },
  fallback: async (input) => {
    const url = new URL(String(input));
    const file = /^\/([0-9a-f-]+)\/(\d+)$/.exec(url.pathname);
    if (url.hostname === "files.resend.com" && file) {
      fileReads++;
      return new Response(Buffer.alloc(messages.get(file[1])?.files[Number(file[2])] ?? 0, 7));
    }
    return new Response("no", { status: 404 });
  },
});
fixture.configure();

/** Bytes of files in every SES send so far, decoded. */
function sentFileBytes(): number {
  let total = 0;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === "RawContent" && typeof v === "string") total += Buffer.from(v, "base64").length;
        else walk(v);
      }
    }
  };
  for (const body of sesBodies) walk(body);
  return total;
}
const sesBodies: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await originalFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/v2/email/outbound-emails" && response.ok && typeof init?.body === "string") sesBodies.push(JSON.parse(init.body));
  return response;
}) as typeof fetch;

let serial = 0;
function message(from: string, files: number[] = [], to = "support@marktmorgen.com"): string {
  serial++;
  const id = `${serial.toString(16).padStart(8, "0")}-02e9-4d39-ad75-9611e0fcc33c`;
  messages.set(id, { from, to, files });
  return id;
}
function fresh() {
  redis.clear();
  fixture.reset();
  fixture.configure();
  sesBodies.length = 0;
  fileReads = 0;
  receivingReads = 0;
  readFails = false;
}
const toSupport = () => fixture.ses.filter((m) => m.subject === "hello");
const notices = () => fixture.ses.filter((m) => m.subject !== "hello");

(async () => {
  part("the ceilings are exported, finite and positive");
  for (const name of ["SUPPORT_SENDER_HOURLY", "SUPPORT_SENDER_DAILY", "SUPPORT_DAILY", "SUPPORT_FILE_BYTES_DAILY", "SUPPORT_HELD_NOTICES_DAILY"]) {
    const value = limits[name];
    is(`${name} is a positive whole number`, Number.isSafeInteger(value) && (value as number) > 0, true);
  }

  part("one sender writes support@ 300 times in an hour (the audit's proof)");
  fresh();
  const flood: string[] = [];
  for (let i = 0; i < 300; i++) flood.push(await forward(message("spammer@example.net", [1_000_000]), NOON));
  is("forwarded: the sender's hourly ceiling and no more", flood.filter((r) => r === "sent").length, HOURLY);
  is("the rest are held, never retried (a retry would only be held again)", flood.filter((r) => r === "held").length, 300 - HOURLY);
  is("SES sends to support: the hourly ceiling", toSupport().length, HOURLY);
  is("files sent: the forwarded messages' only", sentFileBytes(), HOURLY * 1_000_000);
  is("files of held messages are never fetched", fileReads, HOURLY);

  part("the same sender written another way is the same sender");
  fresh();
  const ways = ["Jane.Doe+a@gmail.com", "janedoe+b@googlemail.com", "JANEDOE@GMAIL.COM", "Jane <jane.doe+c@gmail.com>"];
  const wayResults: string[] = [];
  for (let i = 0; i < HOURLY + 4; i++) wayResults.push(await forward(message(ways[i % ways.length]), NOON));
  is("one hourly ceiling for every spelling", wayResults.filter((r) => r === "sent").length, HOURLY);

  part("a sender over a day: SUPPORT_SENDER_DAILY across hours");
  fresh();
  let dailySent = 0;
  for (let hour = 0; hour < 10; hour++) {
    for (let i = 0; i < HOURLY; i++) if ((await forward(message("busy@example.com"), NOON)) === "sent") dailySent++;
    advance(3_601_000);
  }
  is("forwarded in the day: the sender's daily ceiling", dailySent, Math.min(SENDER_DAILY, 10 * HOURLY));

  part("every sender together: SUPPORT_DAILY a UTC day");
  fresh();
  let allSent = 0;
  for (let i = 0; i < DAILY + 25; i++) if ((await forward(message(`person${i}@example.com`), NOON)) === "sent") allSent++;
  is("forwarded: the company's daily ceiling", allSent, DAILY);
  is("the next UTC day sends again", await forward(message("tomorrow@example.com"), NOON + DAY), "sent");

  part("held messages: the inbox is told once a day where they are kept");
  is("one notice for the held day, none for the day that sent", notices().length, 1);
  const notice = notices()[0];
  is("the notice goes to the support inbox", notice?.to, ["owner@example.org"]);
  is("it says where the held messages are: Resend, Emails, Receiving", /Resend/.test(notice?.text ?? "") && /Receiving/.test(notice?.text ?? ""), true);
  is("it says nothing was deleted", /not deleted|Nothing was deleted/i.test(notice?.text ?? ""), true);

  part("files: SUPPORT_FILE_BYTES_DAILY a UTC day, the rest left out and named");
  fresh();
  const big = 14_000_000;
  const fileResults: string[] = [];
  const many = Math.ceil(FILE_BYTES / big) + 3;
  for (let i = 0; i < many; i++) fileResults.push(await forward(message(`files${i}@example.com`, [big]), NOON));
  is("every message is still sent on", fileResults.every((r) => r === "sent"), true);
  is("files sent in the day stay within the ceiling", sentFileBytes() <= FILE_BYTES, true);
  is("as many whole files as fit", sentFileBytes(), Math.floor(FILE_BYTES / big) * big);
  const last = toSupport().at(-1);
  is("a file left out is named, with where to find it", /Not attached \(see Resend, Emails, Receiving\): f0\.bin/.test(last?.text ?? ""), true);

  part("a message tried again is counted once");
  fresh();
  const again = message("retry@example.com", [2_000_000]);
  fixture.setSesOutcome("refused");
  const first = await forward(again, NOON);
  fixture.setSesOutcome("ok");
  const second = await forward(again, NOON);
  is("the first try asks for a retry", first, "retry");
  is("the retry is sent", second, "sent");
  let after = 0;
  for (let i = 0; i < HOURLY; i++) if ((await forward(message("retry@example.com"), NOON)) === "sent") after++;
  is("the retried message took one place of the hour, not two", after, HOURLY - 1);

  part("a count that cannot be read sends nothing and asks again");
  fresh();
  const realPipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: (c: (string | number)[][]) => Promise<unknown[]> }).pipeline = async (commands) => {
    if (commands.some((c) => String(c[1] ?? "").startsWith("nl:rl:support"))) throw new Error("synthetic Redis outage");
    return realPipeline(commands);
  };
  const unknown = await forward(message("someone@example.com", [1_000]), NOON);
  (redis as unknown as { pipeline: typeof realPipeline }).pipeline = realPipeline;
  is("retry, so Resend offers it again", unknown, "retry");
  is("nothing went out", fixture.ses.length, 0);

  part("the store path is untouched by the company's ceilings");
  is("CREATOR_HOURLY is still 40", inbound.CREATOR_HOURLY, 40);

  part("the month's ceiling is in the registry and in docs/funded-exposure-review.md");
  const monthly = (registry as unknown as Record<string, unknown>).supportForwardMonthlyUsd as (() => { modeledUsd: number; completeUsd: null }) | undefined;
  const figure = monthly?.();
  is("the registry prices the month at the ceilings", Number.isFinite(figure?.modeledUsd) && (figure?.modeledUsd ?? 0) > 0, true);
  is("the complete figure stays unknown, never zero", figure?.completeUsd, null);
  const doc = readFileSync("docs/funded-exposure-review.md", "utf8");
  is("the review names the ceiling and its monthly figure", doc.includes("SUPPORT_DAILY") && doc.includes(`$${(figure?.modeledUsd ?? NaN).toFixed(2)}`), true);

  globalThis.fetch = originalFetch;
  fixture.restore();
  done();
})();
