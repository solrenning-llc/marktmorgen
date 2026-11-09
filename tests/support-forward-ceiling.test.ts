/**
 * Mail written to our own support addresses is sent on through SES as a
 * company email (lib/inbound-mail.ts, forwardInbound). Until 9 November 2026
 * nothing bounded it but the webhook's per-connection limit, and the
 * connection is Resend's, not the sender's: one sender wrote support@ 300
 * times with 1 MB each and all 300 messages and 300 MB went out at the
 * company's cost (ALTO 1 of Claude 5's email audit). Spending SES's day also
 * stops buyers' receipts and sign-in links.
 *
 * Held here: announcements of mail not written to a store are counted
 * (SUPPORT_ANNOUNCED_DAILY a UTC day) before the message is read at Resend;
 * a sender (however the address is written) is sent on at most
 * SUPPORT_SENDER_HOURLY times an hour and SUPPORT_SENDER_DAILY a day; all
 * senders together at most SUPPORT_DAILY a UTC day, of which senders with no
 * store under the address SUPPORT_PUBLIC_DAILY; files at most
 * SUPPORT_FILE_BYTES_DAILY bytes a UTC day, each charged once at its listed
 * size and never read past it. Each is counted before the send. A message
 * past a ceiling is "held": not sent on, not tried again, readable in Resend,
 * and the inbox is told once a day. A count that cannot be read sends nothing
 * and asks Resend to try again; each count a message took is marked, so a
 * try again never takes it twice. The store path keeps CREATOR_HOURLY.
 * docs/funded-exposure-review.md carries the month's ceiling the registry
 * computes, and the commands a forward and a held message can send stay
 * within the registry's figures (pre-review of 9 November 2026).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as inbound from "@/lib/inbound-mail";
import { installSesMailFixture } from "./ses-mail-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import * as registry from "./plan-cost-registry";
import { CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS, LLC_FIXED_COST_IDS } from "@/lib/llc-fixed-costs";

process.env.RESEND_API_KEY = "re_SYNTHETIC_TEST_ONLY";
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
process.env.RESEND_INBOUND_API_KEY = "re_SYNTHETIC_INBOUND_ONLY";
process.env.SUPPORT_FORWARD_TO = "owner@example.org";
process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";

const limits = inbound as unknown as Record<string, number | undefined>;
const HOURLY = limits.SUPPORT_SENDER_HOURLY ?? 10;
const SENDER_DAILY = limits.SUPPORT_SENDER_DAILY ?? 30;
const DAILY = limits.SUPPORT_DAILY ?? 200;
const PUBLIC_DAILY = limits.SUPPORT_PUBLIC_DAILY ?? 120;
const ANNOUNCED = limits.SUPPORT_ANNOUNCED_DAILY ?? 1_000;
const CREATOR_SENDER_DAILY = limits.SUPPORT_CREATOR_SENDER_DAILY ?? 30;
const FILE_BYTES = limits.SUPPORT_FILE_BYTES_DAILY ?? 300_000_000;
type Forward = (id: string, now?: number, announcedTo?: unknown) => Promise<string>;
const forward = inbound.forwardInbound as unknown as Forward;
const costs = registry as unknown as Record<string, number | undefined>;

const NOON = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
/** The route's own commands before forwardInbound: its connection limit (SET NX, INCR) and the seen mark. */
const ROUTE_COMMANDS = 3;
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/** What each received message looks like: its sender, where it was written, its files' listed and real sizes. */
const messages = new Map<string, { from: string; to: string; listed: number[]; real: number[] }>();
let fileReads = 0;
let fileBytesRead = 0;
let mailReads = 0;
const fixture = installSesMailFixture({
  onResend: (_m, input) => {
    const url = new URL(String(input));
    const att = /^\/emails\/receiving\/([0-9a-f-]+)\/attachments$/.exec(url.pathname);
    if (att) {
      const m = messages.get(att[1]);
      return json({ data: (m?.listed ?? []).map((size, n) => ({ filename: `f${n}.bin`, size, download_url: `https://files.resend.com/${att[1]}/${n}` })) });
    }
    const one = /^\/emails\/receiving\/([0-9a-f-]+)$/.exec(url.pathname);
    if (one) {
      mailReads++;
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
      const size = messages.get(file[1])?.real[Number(file[2])] ?? 0;
      // Counts what is actually pulled from the body, chunk by chunk.
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) return controller.close();
          const chunk = Math.min(65_536, size - sent);
          sent += chunk;
          fileBytesRead += chunk;
          controller.enqueue(new Uint8Array(chunk).fill(7));
        },
      });
      return new Response(stream);
    }
    return new Response("no", { status: 404 });
  },
});
fixture.configure();

const sesBodies: unknown[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await originalFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/v2/email/outbound-emails" && response.ok && typeof init?.body === "string") sesBodies.push(JSON.parse(init.body));
  return response;
}) as typeof fetch;

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

type Pipe = (c: (string | number)[][]) => Promise<unknown[]>;
const handle = redis as unknown as { pipeline: Pipe };
const realPipeline: Pipe = redis.pipeline.bind(redis);
let commands = 0;
let failing: RegExp | null = null;
handle.pipeline = async (c) => {
  if (failing && c.some((x) => failing!.test(String(x[1] ?? "")))) throw new Error("synthetic Redis outage");
  commands += c.length;
  return realPipeline(c);
};

let serial = 0;
function message(from: string, listed: number[] = [], real: number[] = listed, to = "support@marktmorgen.com"): string {
  serial++;
  const id = `${serial.toString(16).padStart(8, "0")}-02e9-4d39-ad75-9611e0fcc33c`;
  messages.set(id, { from, to, listed, real });
  return id;
}
/** A store under an address, as lib/store.ts keys its owner (only the key's presence is read). */
function makeCreator(email: string, paid = true) {
  const key = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;
  // A paid plan is the store's own subscriptionActive; a free store is a store all the same.
  redis.run(["SET", key, JSON.stringify({ handle: `h${createHash("sha256").update(email).digest("hex").slice(0, 10)}`, name: "Synthetic", email, subscriptionActive: paid })]);
}
function fresh() {
  (inbound as unknown as { forgetSupportDayState?: () => void }).forgetSupportDayState?.();
  redis.clear();
  fixture.reset();
  fixture.configure();
  sesBodies.length = 0;
  fileReads = 0;
  fileBytesRead = 0;
  mailReads = 0;
  failing = null;
}
const toSupport = () => fixture.ses.filter((m) => m.subject === "hello");
const notices = () => fixture.ses.filter((m) => m.subject !== "hello");

(async () => {
  part("the ceilings are exported, finite and positive");
  for (const name of ["SUPPORT_SENDER_HOURLY", "SUPPORT_SENDER_DAILY", "SUPPORT_DAILY", "SUPPORT_PUBLIC_DAILY", "SUPPORT_ANNOUNCED_DAILY", "SUPPORT_FILE_BYTES_DAILY", "SUPPORT_HELD_NOTICES_DAILY"]) {
    const value = limits[name];
    is(`${name} is a positive whole number`, Number.isSafeInteger(value) && (value as number) > 0, true);
  }
  is("the public share is smaller than the day, so creators keep a share", PUBLIC_DAILY < DAILY, true);

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

  part("every sender together: made-up addresses take the public share, creators keep the rest of SUPPORT_DAILY");
  fresh();
  let publicSent = 0;
  for (let i = 0; i < DAILY + 25; i++) if ((await forward(message(`person${i}@random${i}.example`), NOON)) === "sent") publicSent++;
  // Changed 9 November 2026 (pre-review item 4; rule 23): "forwarded: the company's daily ceiling" wanted DAILY from
  // made-up addresses; they now stop at the public share, so they can no longer hold every creator for the day.
  is("forwarded from senders with no store: the public share", publicSent, PUBLIC_DAILY);
  is("a buyer with no store writing afterwards is held too: From is not authenticated, so no sender can be told from a made-up one", await forward(message("buyer@customer.example"), NOON + 60_000), "held");
  let creatorSent = 0;
  for (let i = 0; i < DAILY; i++) {
    const address = `creator${i}@studio${i}.example`;
    makeCreator(address);
    if ((await forward(message(address), NOON + 60_000)) === "sent") creatorSent++;
  }
  is("creators are still sent on, up to the company's daily ceiling", creatorSent, DAILY - PUBLIC_DAILY);
  is("the next UTC day sends again", await forward(message("tomorrow@example.com"), NOON + DAY), "sent");

  part("held messages: the inbox is told once a day, without promising what no source says");
  is("one notice for the held day, none for the day that sent", notices().length, 1);
  const notice = notices()[0];
  is("the notice goes to the support inbox", notice?.to, ["owner@example.org"]);
  is("it says plainly the messages were not sent and will not be, where to read them, and that this site keeps no copy",
    (notice?.text ?? "").includes("These messages were not sent on and will not be sent later. Read them in Resend (Emails, Receiving); this site keeps no copy. New messages are sent on again as usual."), true);
  // Changed 9 November 2026 (pre-review item 6; rule 23): "it says nothing was deleted" wanted the notice to promise
  // that nothing was deleted; no dated source says how long Resend keeps a message, so it no longer promises that.
  is("it does not promise every message is kept or that sending resumes by itself", /Every message is kept|Nothing was deleted|starts again by itself/.test(notice?.text ?? ""), false);

  part("announcements of support mail are counted before the message is read at Resend");
  fresh();
  for (let i = 0; i < ANNOUNCED; i++) await forward(message(`a${i}@q${i}.example`), NOON);
  const readsBefore = mailReads;
  commands = 0;
  const pastAnnounced: string[] = [];
  for (let i = 0; i < 50; i++) pastAnnounced.push(await forward(message(`b${i}@q${i}.example`), NOON));
  is("past the day's announcements: held without reading Resend", [mailReads - readsBefore, pastAnnounced.every((r) => r === "held")], [0, true]);
  is("each costs a few commands only (the counter and the day's notice mark)", (commands + 50 * ROUTE_COMMANDS) / 50 <= ROUTE_COMMANDS + 3, true);
  const toStore = await forward(message("buyer@example.com", [], [], "nobody-here@mail.marktmorgen.com"), NOON, ["nobody-here@mail.marktmorgen.com"]);
  is("mail the announcement shows written to a store is not support's: still read, then dropped as no store's", [toStore, mailReads - readsBefore], ["skipped", 1]);

  part("a held message that was read stays within the registry's commands");
  fresh();
  for (let i = 0; i < HOURLY; i++) await forward(message("loud@example.com"), NOON);
  commands = 0;
  await forward(message("loud@example.com"), NOON);
  is(`held after its read: ${commands + ROUTE_COMMANDS} commands, at most SUPPORT_HELD_READ_COMMANDS`, commands + ROUTE_COMMANDS <= (costs.SUPPORT_HELD_READ_COMMANDS ?? 0), true);

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

  part("a file is charged once, at its listed size, and never read past it");
  fresh();
  commands = 0;
  const hundred = Array.from({ length: 100 }, () => 1_000);
  const larger = Array.from({ length: 100 }, () => 1_001);
  is("a message whose 100 files are bigger than listed is still sent on", await forward(message("files@example.com", hundred, larger), NOON), "sent");
  is(`${commands + ROUTE_COMMANDS} commands for the whole forward, at most SUPPORT_FORWARD_COMMANDS`, commands + ROUTE_COMMANDS <= (costs.SUPPORT_FORWARD_COMMANDS ?? 0), true);
  is("files bigger than listed are left out, none sent", sentFileBytes(), 0);
  // The stand-in's stream may be pulled a chunk or two ahead of the reader: three chunks a file bound that, not the file.
  is("and never read much past their listed size (a few chunks at most each)", fileBytesRead <= 100 * 3 * 65_536, true);
  fresh();
  commands = 0;
  is("a message with 100 files at their listed sizes is sent on with all of them", [await forward(message("full@example.com", hundred), NOON), sentFileBytes()], ["sent", 100_000]);
  is(`${commands + ROUTE_COMMANDS} commands with every file charged, at most SUPPORT_FORWARD_COMMANDS`, commands + ROUTE_COMMANDS <= (costs.SUPPORT_FORWARD_COMMANDS ?? 0), true);
  fresh();
  is("a file listed with no size is not read whole", [await forward(message("zero@example.com", [0], [5_000_000]), NOON), fileBytesRead <= 3 * 65_536, sentFileBytes()], ["sent", true, 0]);

  part("a message tried again is counted once");
  fresh();
  const again = message("retry@example.com", [2_000_000]);
  fixture.setSesOutcome("refused");
  const first = await forward(again, NOON);
  fixture.setSesOutcome("ok");
  const second = await forward(again, NOON);
  is("the first try asks for a retry", first, "retry");
  is("the retry is sent", second, "sent");
  is("its files were charged once", Number(redis.run(["GET", `nl:inbound:support:bytes:${new Date(NOON).toISOString().slice(0, 10)}`])), 2_000_000);
  let after = 0;
  for (let i = 0; i < HOURLY; i++) if ((await forward(message("retry@example.com"), NOON)) === "sent") after++;
  is("the retried message took one place of the hour, not two", after, HOURLY - 1);

  part("a company count that cannot be read, tried again, does not take the sender's hour again");
  fresh();
  for (let i = 0; i < 6; i++) await forward(message("client@customer.example"), NOON);
  const seventh = message("client@customer.example");
  failing = /^nl:rl:support-forward:/;
  const tries: string[] = [];
  for (let i = 0; i < 4; i++) { tries.push(await forward(seventh, NOON + i * 60_000)); advance(60_000); }
  failing = null;
  tries.push(await forward(seventh, NOON + 5 * 60_000));
  is("retry while the count is out of reach, sent once it reads again", tries, ["retry", "retry", "retry", "retry", "sent"]);
  let left = 0;
  for (let i = 0; i < HOURLY; i++) if ((await forward(message("client@customer.example"), NOON + 6 * 60_000)) === "sent") left++;
  is("the hour holds the seven messages, not the four tries", left, HOURLY - 7);

  part("a count that cannot be read sends nothing and asks again");
  fresh();
  failing = /^nl:rl:support/;
  const unknown = await forward(message("someone@example.com", [1_000]), NOON);
  failing = null;
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
  is("the review names the ceilings and its monthly figure", ["SUPPORT_DAILY", "SUPPORT_PUBLIC_DAILY", "SUPPORT_ANNOUNCED_DAILY"].every((n) => doc.includes(n)) && doc.includes(`$${(figure?.modeledUsd ?? NaN).toFixed(2)}`), true);
  is("the review does not promise held messages are kept", /Every message is kept|is held, not dropped/.test(doc), false);


  part("2nd pre-review MEDIO 1: only a PAID plan's address counts as a creator, and one creator address has its own small day");
  is("SUPPORT_CREATOR_SENDER_DAILY is a positive whole number well under the sender's day", Number.isSafeInteger(limits.SUPPORT_CREATOR_SENDER_DAILY) && CREATOR_SENDER_DAILY > 0 && CREATOR_SENDER_DAILY < SENDER_DAILY, true);
  fresh();
  for (let s = 0; s < 7; s++) makeCreator(`attacker${s}@evil.example`, false);
  let fromFree = 0;
  for (let h = 0; h < 3; h++) { for (let s = 0; s < 7; s++) for (let i = 0; i < HOURLY; i++) if ((await forward(message(`attacker${s}@evil.example`), NOON)) === "sent") fromFree++; advance(3_601_000); }
  is("7 self-made FREE stores take the public share only", fromFree <= PUBLIC_DAILY, true);
  makeCreator("paying-creator@studio.example");
  is("a paying creator's own message is still sent on", await forward(message("paying-creator@studio.example"), NOON), "sent");

  fresh();
  for (let i = 0; i < PUBLIC_DAILY; i++) await forward(message(`x${i}@made${i}.example`), NOON);
  const known = ["known0", "known1", "known2"].map((n) => `${n}@studio.example`);
  known.forEach((a) => makeCreator(a));
  let forged = 0;
  for (let h = 0; h < 3; h++) { for (const a of known) for (let i = 0; i < HOURLY; i++) if ((await forward(message(a), NOON)) === "sent") forged++; advance(3_601_000); }
  is("a forged From of known paying creators takes at most the small day each", forged <= known.length * CREATOR_SENDER_DAILY, true);
  makeCreator("paying-creator2@studio.example");
  is("another paying creator is still sent on", await forward(message("paying-creator2@studio.example"), NOON), "sent");

  part("2nd pre-review MEDIO 3: past the day's announcements a held one costs no command beyond the route's");
  fresh();
  for (let i = 0; i < ANNOUNCED + 1; i++) await forward(message(`a${i}@q${i}.example`), NOON);
  commands = 0;
  const pastDay: string[] = [];
  for (let i = 0; i < 500; i++) pastDay.push(await forward(message(`b${i}@q${i}.example`), NOON));
  is("500 more are held", pastDay.every((r) => r === "held"), true);
  is("with no command of ours (a memory of the exhausted day, per instance)", commands, 0);
  is("and the inbox still got one notice for the day", notices().length, 1);

  part("2nd pre-review MEDIO 2: the support forward is a line of the LLC's fixed costs, unknown");
  is("support-forward in LLC_FIXED_COST_IDS", (LLC_FIXED_COST_IDS as readonly string[]).includes("support-forward"), true);
  const supportLine = CURRENT_LLC_FIXED_COST_CEILINGS.find((l) => l.id === "support-forward");
  is("its ceiling is unknown", [supportLine?.fullMonthlyUsdCents, supportLine?.fullAnnualUsdCents, supportLine?.reserveReviewed], [null, null, false]);
  is("its observation is not an approved ceiling", (FIXED_COST_SOURCE_OBSERVATIONS as unknown as Record<string, { approvedCeiling?: boolean } | undefined>).supportForward?.approvedCeiling, false);

  part("2nd pre-review LEVE 4: the notice names the address the held mail was written to");
  fresh();
  for (let i = 0; i < HOURLY; i++) await forward(message("loud@example.com", [], [], "orders@marktmorgen.com"), NOON);
  await forward(message("loud@example.com", [], [], "orders@marktmorgen.com"), NOON);
  is("held after its read: orders@, not support@", [/written to orders@marktmorgen\.com/.test(notices()[0]?.text ?? ""), /written to support@/.test(notices()[0]?.text ?? "")], [true, false]);
  fresh();
  for (let i = 0; i < ANNOUNCED; i++) await forward(message(`a${i}@q${i}.example`), NOON);
  await forward(message("late@q.example", [], [], "hello@marktmorgen.com"), NOON, ["hello@marktmorgen.com"]);
  is("held at the announcement: hello@", [/written to hello@marktmorgen\.com/.test(notices()[0]?.text ?? ""), /written to support@/.test(notices()[0]?.text ?? "")], [true, false]);

  globalThis.fetch = originalFetch;
  fixture.restore();
  done();
})();
