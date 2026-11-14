/**
 * The notice form's emails have a company ceiling a day, and no notice is ever refused for it (lib/takedown-mail.ts).
 * Until 14 November 2026 every notice sent its own email to the support inbox with only a per-address limit, so many
 * networks sending the form cost the company an email each, with nothing bounding the day. Now: past the day's
 * ceiling a notice is still kept and answered as received, and the day's digest carries it with a link that opens it.
 * Synthetic Redis and email provider only.
 */
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport } from "@/lib/takedown";
import { HELD_NOTICES_KEY, REPORT_EMAILS_PER_DAY, sendHeldNoticeDigest } from "@/lib/takedown-mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The day's ceiling of one-by-one emails (REPORT_EMAILS_PER_DAY in lib/takedown-mail.ts). */
const CEILING = 40;

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
let failSending = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && failSending && new URL(String(input)).pathname === "/emails") return new Response("{}", { status: 422 });
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const NOTICE = {
  kind: "copyright",
  url: `${ORIGIN}/@ceilingshop`,
  work: "My photo 'Harbor at Dawn', sold on this page without my permission.",
  original: "https://example.com/harbor-at-dawn",
  name: "Nora Notifier",
  email: "nora@example.com",
  contact: "+1 555 0101",
  signature: "Nora Notifier",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("the synthetic notice was refused");

  part("Past the day's ceiling, from as many networks as there are notices");
  const results: string[] = [];
  for (let i = 0; i < CEILING + 7; i += 1) results.push(await fileReport(read.report, `198.51.${Math.floor(i / 250)}.${i % 250}`, ORIGIN));
  is("every notice is answered as received, none refused", results.filter((result) => result !== "sent"), []);
  is("the support inbox got one email each up to the ceiling, no more", sent.length, CEILING);
  is("every notice is kept", redis.keys().filter((key) => /^nl:report:[0-9a-f]{16}$/.test(key)).length, CEILING + 7);
  is("the ceiling read here is the code's", REPORT_EMAILS_PER_DAY, CEILING);

  part("The day's digest carries every notice past the ceiling, each with a link that opens it");
  const before = sent.length;
  const digest = await sendHeldNoticeDigest(ORIGIN);
  is("one digest for the seven, nothing left waiting", [digest, sent.length - before], [{ ok: true, sent: 7, waiting: 0 }, 1]);
  const text = sent[sent.length - 1]?.text ?? "";
  const tokens = [...text.matchAll(/\/takedown\/([0-9a-f]{48})/g)].map((match) => match[1]);
  is("seven links, one for each", tokens.length, 7);
  const opened = await openReport(tokens[0]);
  is("a digest's link opens its notice", opened?.report.email, NOTICE.email);
  is("the queue is empty", redis.run(["LLEN", HELD_NOTICES_KEY]), 0);
  const again = await sendHeldNoticeDigest(ORIGIN);
  is("a second run the same day sends nothing", [again.sent, sent.length - before], [0, 1]);

  part("A digest that could not be sent keeps every notice for the next run");
  redis.clear();
  sent.length = 0;
  for (let i = 0; i < CEILING + 2; i += 1) await fileReport(read.report, `203.0.113.${i}`, ORIGIN);
  failSending = true;
  const failed = await sendHeldNoticeDigest(ORIGIN);
  failSending = false;
  is("not sent: both still wait", [failed.ok, redis.run(["LLEN", HELD_NOTICES_KEY])], [false, 2]);
  const retried = await sendHeldNoticeDigest(ORIGIN);
  is("the next run sends them", [retried.sent, redis.run(["LLEN", HELD_NOTICES_KEY])], [2, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
