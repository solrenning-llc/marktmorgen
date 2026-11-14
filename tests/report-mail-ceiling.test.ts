/**
 * The notice form's emails have a company ceiling a day, and no notice is ever refused for it (lib/takedown-mail.ts).
 * Until 14 November 2026 every notice sent its own email to the support inbox with only a per-address limit, so many
 * networks sending the form cost the company an email each, with nothing bounding the day. Now: past the day's
 * ceiling a notice is still kept and answered as received, and the day's digest carries it with a link that opens it.
 * Synthetic Redis and email provider only.
 */
import { readReport } from "@/lib/takedown-rules";
import { fileReport, openReport } from "@/lib/takedown";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The day's ceiling of one-by-one emails (REPORT_EMAILS_PER_DAY in lib/takedown-mail.ts). */
const CEILING = 40;

type Sent = { to: string[] | string; subject: string; text: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
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

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
