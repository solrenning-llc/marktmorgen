/**
 * Sweep A3 proof (CX-123 rules 24 and 27), synthetic only: a stand-in for Resend (reading and sending).
 * lib/inbound-mail.ts files(), lines 203-206: the list of a received message's files is read as
 * `(listed.data as { data?: unknown } | null)?.data` and `Array.isArray(entries) ? ... : []`. When Resend answers the
 * list with an error (read() keeps `data: null` for any non-2xx status) or with a body of another shape, the message
 * is "a message with no files": forwardInbound sends it on as "sent", with no file and no "Not attached" line, so
 * the inbox (or the creator) is never told that the writer's files were left out, and Resend is not asked again.
 */
import { forwardInbound } from "@/lib/inbound-mail";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
type Sent = { text: string; attachments?: { filename: string }[] };
const sent: Sent[] = [];
let filesStatus = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "e" }));
  }
  if (url.hostname === "api.resend.com" && url.pathname === `/emails/receiving/${ID}/attachments`) {
    if (filesStatus !== 200) return new Response(JSON.stringify({ name: "internal_server_error" }), { status: filesStatus });
    return new Response(JSON.stringify({ object: "list", has_more: false, data: [{ id: "f1", filename: "receipt.pdf", size: 5, download_url: "https://inbound-cdn.resend.com/a/receipt.pdf" }] }));
  }
  if (url.hostname === "api.resend.com" && url.pathname === `/emails/receiving/${ID}`) {
    return new Response(JSON.stringify({ object: "email", id: ID, from: "jane@example.com", to: ["support@marktmorgen.com"], received_for: ["support@marktmorgen.com"], reply_to: [], subject: "My receipt", text: "Attached is my receipt.", headers: {} }));
  }
  if (url.hostname === "inbound-cdn.resend.com") return new Response(Buffer.from("hello"));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";

  part("Healthy control: the file is listed and sent on");
  is("sent, with receipt.pdf", [await forwardInbound(ID), sent.at(-1)?.attachments?.map((a) => a.filename)], ["sent", ["receipt.pdf"]]);

  part("DEFECT: Resend answers the list of files with a 500");
  filesStatus = 500;
  const outcome = await forwardInbound(ID);
  const mail = sent.at(-1);
  is("DEFECT: 'sent' (no retry), with no file", [outcome, mail?.attachments?.length ?? 0], ["sent", 0]);
  is("DEFECT: and nothing in the message says a file was left out", /Not attached/.test(mail?.text ?? ""), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
