/**
 * Rule MR audit, G1 (kept RED, no fix: the ceiling's figure and what a refused notice is told are the owner's to
 * decide, since the form is the notice channel of DSA Art. 16 and DMCA 512(c)). A notice filed from the public form
 * (app/api/report/route.ts, lib/takedown.ts fileReport) sends one company email to support and keeps a record for 400
 * days. Its only limit is five an hour per connection (withinLimit "report"), so notices from many connections are
 * each a company email and a stored record, with no ceiling across the site: unbounded spend by anonymous visitors,
 * and, once SES's daily quota is used, no sign-in links or receipts for anyone that day.
 *
 * What must hold once decided: past a site-wide figure for the day, no email is sent and nothing is kept for a
 * notice (the figure is not written here; this test asks only that some ceiling holds below 300 a day).
 */
import { fileReport } from "@/lib/takedown";
import { readReport } from "@/lib/takedown-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(init?.body);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "copyright",
  url: "https://marktmorgen.com/@noticeshop",
  work: "My song 'Harbor Lights', played on this page from a SoundCloud upload I did not make.",
  original: "https://example.com/harbor-lights",
  name: "Rita Owner",
  email: "rita@example.com",
  contact: "+1 555 0100",
  signature: "Rita Owner",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_notice_ceiling_a_stand_in";
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("notice not read");
  part("Notices from many connections in one day");
  let filed = 0;
  for (let i = 0; i < 300; i += 1) {
    const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
    const r = await fileReport(read.report, ip, "https://marktmorgen.com");
    if (r === "sent") filed += 1;
  }
  const kept = redis.keys().filter((k) => k.startsWith("nl:report:") && !k.startsWith("nl:report:t:")).length;
  is("300 notices from 300 connections: some site-wide ceiling stops the company emails before 300", sent.length < 300, true);
  is("and the records kept for 400 days stop with them", kept < 300, true);
  console.log(`today: ${filed} filed, ${sent.length} emails, ${kept} records kept`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
