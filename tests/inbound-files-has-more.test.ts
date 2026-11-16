/**
 * The list of a received message's files is read from Resend one page at a time (lib/inbound-mail.ts,
 * files(), limit=100). Resend's API for it is not followed further with a cursor here: no cursor is
 * read anywhere in this code base, so one is not guessed. A page that says more files exist
 * (has_more true), or a page longer than the 100 asked for, must not read as "every file": the message
 * still goes on with the files it could attach, and a line says plainly that more files were sent than
 * could be attached. A page that does not say whether more exist (has_more missing or not a boolean)
 * is unknown, never "no more": the line says some files may not be attached. A page with has_more
 * false adds no such line. Synthetic only: a stand-in for Resend, reading and sending.
 */
import { forwardInbound } from "@/lib/inbound-mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "6a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
type Sent = { text: string; html?: string; attachments?: { filename: string }[] };
const sent: Sent[] = [];
const file = (n: number) => ({ id: `f${n}`, filename: `scan-${n}.pdf`, size: 5, download_url: `https://inbound-cdn.resend.com/a/scan-${n}.pdf` });
let filesAnswer: unknown = { object: "list", has_more: false, data: [file(1)] };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "e" }));
  }
  if (url.hostname === "api.resend.com" && url.pathname === `/emails/receiving/${ID}/attachments`) return new Response(JSON.stringify(filesAnswer));
  if (url.hostname === "api.resend.com" && url.pathname === `/emails/receiving/${ID}`) {
    return new Response(JSON.stringify({ object: "email", id: ID, from: "jane@example.com", to: ["support@marktmorgen.com"], received_for: ["support@marktmorgen.com"], reply_to: [], subject: "My scans", text: "Here are my scans.", html: "<p>Here are my scans.</p>", headers: {} }));
  }
  if (url.hostname === "inbound-cdn.resend.com") return new Response(Buffer.from("hello"));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function forwardWith(answer: unknown): Promise<[string, Sent | undefined]> {
  redis.clear();
  filesAnswer = answer;
  const before = sent.length;
  const outcome = await forwardInbound(ID);
  return [outcome, sent.length > before ? sent.at(-1) : undefined];
}

const MORE = "More files were sent than could be attached here (see Resend, Emails, Receiving)";
const MAYBE = "Some files may not be attached here (see Resend, Emails, Receiving)";
const header = (mail: Sent | undefined) => (mail?.text ?? "").split("\n\n")[0].split("\n");

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";

  part("Control: Resend says there are no more files");
  const [plain, whole] = await forwardWith({ object: "list", has_more: false, data: [file(1)] });
  is("sent, with its one file", [plain, whole?.attachments?.map((a) => a.filename)], ["sent", ["scan-1.pdf"]]);
  is("and no line about more files", header(whole), ["From: jane@example.com", "To: support@marktmorgen.com"]);

  part("Resend says more files exist than the page it sent");
  const hundred = Array.from({ length: 100 }, (_, n) => file(n + 1));
  const [outcome, mail] = await forwardWith({ object: "list", has_more: true, data: hundred });
  is("the message still goes on, with the files it could attach", [outcome, mail?.attachments?.length], ["sent", 100]);
  is("and the text says more files were sent than could be attached", header(mail), ["From: jane@example.com", "To: support@marktmorgen.com", MORE]);
  is("the page says so too", (mail?.html ?? "").includes(MORE), true);

  part("A page longer than the 100 asked for: the rest are not dropped quietly");
  const [long, longMail] = await forwardWith({ object: "list", has_more: false, data: Array.from({ length: 101 }, (_, n) => file(n + 1)) });
  is("sent, with 100 files and the line about more", [long, longMail?.attachments?.length, header(longMail).at(-1)], ["sent", 100, MORE]);

  part("A page that does not say whether more exist is not 'no more'");
  for (const [label, answer] of [
    ["has_more missing", { object: "list", data: [file(1)] }],
    ["has_more null", { object: "list", has_more: null, data: [file(1)] }],
    ["has_more a string", { object: "list", has_more: "false", data: [file(1)] }],
  ] as const) {
    const [got, maybe] = await forwardWith(answer);
    is(`${label}: sent, with its file and a line that some may be missing`, [got, maybe?.attachments?.map((a) => a.filename), header(maybe).at(-1)], ["sent", ["scan-1.pdf"], MAYBE]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
