/**
 * The list of a received message's files is read from Resend before the message is sent on
 * (lib/inbound-mail.ts, files()). An answer that is not a list (an error status, or a body of another
 * shape) says nothing about the files, so it must not be read as "a message with no files": that would
 * send the message on as "sent", with the writer's files left out and nothing saying so, and Resend
 * would not be asked again. It is answered "retry", like a list that could not be fetched at all, so
 * the announcement is answered with a failure and Resend makes it again (its retries are bounded, and
 * the message stays in Resend's dashboard whatever happens). A real list that is empty still means no
 * files. Synthetic only: a stand-in for Resend, reading and sending.
 */
import { CREATOR_HOURLY, forwardInbound } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
type Sent = { text: string; to?: string[]; attachments?: { filename: string }[] };
/** Where the received message was written: our own support address, or a store's own address. */
let writtenTo = "support@marktmorgen.com";
const RECEIVED = /^\/emails\/receiving\/([0-9a-f-]{36})(\/attachments)?$/;
const sent: Sent[] = [];
const ONE_FILE = { object: "list", has_more: false, data: [{ id: "f1", filename: "receipt.pdf", size: 5, download_url: "https://inbound-cdn.resend.com/a/receipt.pdf" }] };
let filesAnswer: { status: number; body: string } = { status: 200, body: JSON.stringify(ONE_FILE) };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "e" }));
  }
  const received = url.hostname === "api.resend.com" ? RECEIVED.exec(url.pathname) : null;
  if (received?.[2]) return new Response(filesAnswer.body, { status: filesAnswer.status });
  if (received) {
    return new Response(JSON.stringify({ object: "email", id: received[1], from: "jane@example.com", to: [writtenTo], received_for: [writtenTo], reply_to: [], subject: "My receipt", text: "Attached is my receipt.", headers: {} }));
  }
  if (url.hostname === "inbound-cdn.resend.com") return new Response(Buffer.from("hello"));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/**
 * Forwards once under the given answer to the list of files: the outcome and how many messages were sent.
 * The store is emptied first, so the send's own record of an earlier delivery (kept under the message's
 * idempotency key) does not hide whether this call sent anything.
 */
async function forwardUnder(status: number, body: unknown): Promise<[string, number]> {
  redis.clear();
  filesAnswer = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  const before = sent.length;
  const outcome = await forwardInbound(ID);
  return [outcome, sent.length - before];
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";

  part("Healthy controls");
  is("a listed file is sent on", [await forwardUnder(200, ONE_FILE), sent.at(-1)?.attachments?.map((a) => a.filename)], [["sent", 1], ["receipt.pdf"]]);
  is("a real, empty list: sent, with no file", [await forwardUnder(200, { object: "list", has_more: false, data: [] }), sent.at(-1)?.attachments ?? []], [["sent", 1], []]);
  is("and with no 'Not attached' line", /Not attached/.test(sent.at(-1)?.text ?? ""), false);

  part("An answer that is not a list of files is not 'no files'");
  is("Resend answers the list with a 500: retry, nothing sent", await forwardUnder(500, { name: "internal_server_error" }), ["retry", 0]);
  is("Resend answers the list with a 429: retry, nothing sent", await forwardUnder(429, { name: "rate_limit_exceeded" }), ["retry", 0]);
  is("Resend answers the list with a 401: retry, nothing sent", await forwardUnder(401, { name: "restricted_api_key" }), ["retry", 0]);
  is("Resend answers the list with a 404: retry, nothing sent", await forwardUnder(404, { name: "not_found" }), ["retry", 0]);
  is("a 200 with no list in it: retry, nothing sent", await forwardUnder(200, { object: "list" }), ["retry", 0]);
  is("a 200 whose list is not a list: retry, nothing sent", await forwardUnder(200, { object: "list", data: "none" }), ["retry", 0]);
  is("a 200 that is not JSON: retry, nothing sent", await forwardUnder(200, "<html>oops</html>"), ["retry", 0]);
  is("a 200 with null: retry, nothing sent", await forwardUnder(200, "null"), ["retry", 0]);
  is("a 200 whose list holds an entry that is not an object: retry, nothing sent", await forwardUnder(200, { object: "list", data: [null] }), ["retry", 0]);

  part("And once Resend answers again, the message goes on with its file");
  is("sent, with receipt.pdf", [await forwardUnder(200, ONE_FILE), sent.at(-1)?.attachments?.map((a) => a.filename)], [["sent", 1], ["receipt.pdf"]]);

  // LEVE on #2919: a retry must not spend the store's hourly allowance, or a list outage turns
  // "files missing" into "message missing" once the allowance runs out (the route answers 200 to a skip).
  part("Retries while the list is unreadable do not spend a store's hourly allowance");
  redis.clear();
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  writtenTo = "harborkitchen@mail.marktmorgen.com";
  const other = (n: number) => `4ef9a417-02e9-4d39-ad75-${n.toString(16).padStart(12, "0")}`;
  filesAnswer = { status: 500, body: JSON.stringify({ name: "internal_server_error" }) };
  const before = sent.length;
  const retries: string[] = [];
  for (let i = 0; i < CREATOR_HOURLY + 2; i += 1) retries.push(await forwardInbound(ID));
  is(`${CREATOR_HOURLY + 2} attempts while the list answers 500: each a retry, nothing sent`, [retries.every((r) => r === "retry"), sent.length - before], [true, 0]);
  filesAnswer = { status: 200, body: JSON.stringify(ONE_FILE) };
  is("once the list answers, the same message reaches the creator", [await forwardInbound(ID), sent.at(-1)?.to], ["sent", ["ana@example.org"]]);
  is("and a new message to the same store that hour too", [await forwardInbound(other(1)), sent.at(-1)?.to], ["sent", ["ana@example.org"]]);
  const more: string[] = [];
  for (let i = 2; i < CREATOR_HOURLY; i += 1) more.push(await forwardInbound(other(i)));
  is(`the allowance still counts each message once: ${CREATOR_HOURLY} in the hour are sent`, more.every((r) => r === "sent"), true);
  is("and the next one that hour is held back, as before", await forwardInbound(other(CREATOR_HOURLY)), "skipped");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
