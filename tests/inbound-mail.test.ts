/**
 * Mail written to the site's own addresses, sent on to the inbox that reads it.
 *
 * support@marktmorgen.com is printed across the site and had nothing behind
 * it: the domain sends through Resend and received nowhere. Resend now
 * receives for it, and announces each message to app/api/mail/inbound. What
 * is checked, with Resend played by a stand-in:
 *
 *   - nothing is received until the three settings are there, and the inbox
 *     may not be on the site's own domain;
 *   - an announcement without Resend's signature, or with an old one, is
 *     refused;
 *   - a signed one is fetched and sent on once: from the site's own address,
 *     with the writer's name, Reply-To the writer, the text, the page and the
 *     files, and a repeat of the same announcement sends nothing;
 *   - a file that is not on Resend's hosts, or that would pass the ceiling,
 *     is left out and named;
 *   - a message this file sent on itself is not sent on again;
 *   - when sending fails, the answer is a failure and the retry is heard;
 *   - an answer written to a store's own address on the creators' domain
 *     goes to that creator and nobody else, mail to a name that is no
 *     store's is dropped, and a store is sent on only so many an hour.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { CREATOR_HOURLY, forwardTarget, inboundSigned, isInboundConfigured, parseSender } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const A = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const B = "5ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const C = "6ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const D = "8ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const E = "9ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const F = "aef9a417-02e9-4d39-ad75-9611e0fcc33c";

type Sent = { from: string; to: string[]; subject: string; text: string; html?: string; reply_to?: string; attachments?: { filename: string; content: string }[]; headers?: Record<string, string> };
const sent: { body: Sent; key: string | null; auth: string | null }[] = [];
const reads: string[] = [];
let failSending = false;
let failureStatus = 429;
let outboundPosts = 0;
let refuseCreators = false;

const MAILS: Record<string, unknown> = {
  [A]: {
    object: "email",
    id: A,
    from: "jane@example.com",
    to: ["support@marktmorgen.com"],
    received_for: ["support@marktmorgen.com"],
    reply_to: [],
    subject: "Refund for my order",
    text: "Hello, I bought the guide twice.",
    html: "<p>Hello, I bought the guide <b>twice</b>.</p>",
    headers: { from: "Jane Doe <jane@example.com>", "mime-version": "1.0" },
  },
  [B]: {
    object: "email",
    id: B,
    from: '"Marktmorgen" <support@marktmorgen.com>',
    to: ["hello@marktmorgen.com"],
    subject: "Round and round",
    text: "x",
    headers: { "x-marktmorgen-forwarded": "1" },
  },
  [C]: {
    object: "email",
    id: C,
    from: "Sam <sam@example.org>",
    to: ["hello@marktmorgen.com"],
    reply_to: ["Sam at work <sam@work.example.org>"],
    subject: "",
    text: null,
    html: "<div>Only a page<br>two lines &amp; a sign</div>",
    headers: {},
  },
  // Written to another site that receives through the same Resend account.
  [D]: {
    object: "email",
    id: D,
    from: "Ana <ana@example.org>",
    to: ["support@hazelsong.com"],
    received_for: ["support@hazelsong.com"],
    reply_to: [],
    subject: "My wall",
    text: "Where do I paste the code?",
    headers: {},
  },
  // An answer to a creator's email, from a mail app that ignored Reply-To.
  [E]: {
    object: "email",
    id: E,
    from: "Lee <lee@example.org>",
    to: ["HarborKitchen@mail.marktmorgen.com"],
    received_for: ["harborkitchen@mail.marktmorgen.com"],
    reply_to: [],
    subject: "Re: The autumn menu",
    text: "Is the pie still on?",
    headers: {},
  },
  // And one to a name on that domain that is no store's.
  [F]: {
    object: "email",
    id: F,
    from: "Spam <spam@example.org>",
    to: ["nobody-here@mail.marktmorgen.com"],
    received_for: ["nobody-here@mail.marktmorgen.com"],
    subject: "Buy now",
    text: "x",
    headers: {},
  },
};
let mailSerial = 0;
const originalOf = new Map<string, string>();
function newMailLike(original: string): string {
  const id = `bef9a417-02e9-4d39-ad75-${(++mailSerial).toString(16).padStart(12, "0")}`;
  MAILS[id] = { ...MAILS[original] as Record<string, unknown>, id };
  originalOf.set(id, original);
  return id;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    outboundPosts++;
    if (failSending) return new Response("{}", { status: failureStatus });
    // A key that may not send from the creators' domain.
    if (refuseCreators && /@mail\.marktmorgen\.com/.test(String((JSON.parse(String(init?.body)) as Sent).from))) return new Response("{}", { status: 403 });
    sent.push({ body: JSON.parse(String(init?.body)) as Sent, key: headers.get("Idempotency-Key"), auth: headers.get("Authorization") });
    return new Response(JSON.stringify({ id: "e" }));
  }
  if (url.hostname === "api.resend.com") {
    reads.push(`${headers.get("Authorization")} ${url.pathname}`);
    const files = url.pathname.match(/^\/emails\/receiving\/([^/]+)\/attachments$/);
    if (files) {
      const data =
        (originalOf.get(files[1]) ?? files[1]) === A
          ? [
              { id: "f1", filename: "receipt.pdf", size: 5, content_type: "application/pdf", download_url: "https://inbound-cdn.resend.com/a/receipt.pdf?signature=s" },
              { id: "f2", filename: "elsewhere.png", size: 5, content_type: "image/png", download_url: "https://example.com/elsewhere.png" },
              { id: "f3", filename: "huge.zip", size: 20_000_000, content_type: "application/zip", download_url: "https://inbound-cdn.resend.com/a/huge.zip" },
            ]
          : [];
      return new Response(JSON.stringify({ object: "list", has_more: false, data }));
    }
    const one = url.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (one && MAILS[one[1]]) return new Response(JSON.stringify(MAILS[one[1]]));
    return new Response("{}", { status: 404 });
  }
  if (url.hostname === "inbound-cdn.resend.com") return new Response(Buffer.from("hello"));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function announce(emailId: string, opts: { id?: string; at?: number; secret?: Buffer; type?: string } = {}): NextRequest {
  const id = opts.id ?? `msg_${emailId.slice(0, 8)}`;
  const at = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const body = JSON.stringify({ type: opts.type ?? "email.received", created_at: "2026-10-03T00:00:00.000Z", data: { email_id: emailId, from: "x", to: ["y"], subject: "z" } });
  const signature = createHmac("sha256", opts.secret ?? SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,AAAA v1,${signature}` },
    body,
  });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_sending_only";

  part("Switched on only with all three settings");
  is("nothing set: not found", (await POST(announce(A))).status, 404);
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  is("no inbox yet: not found", (await POST(announce(A))).status, 404);
  process.env.SUPPORT_FORWARD_TO = "support@marktmorgen.com";
  is("an inbox on the site's own domain is no inbox", [forwardTarget(), isInboundConfigured()], [null, false]);
  process.env.SUPPORT_FORWARD_TO = "two@example.net, three@example.net";
  is("two addresses are no inbox", forwardTarget(), null);
  process.env.SUPPORT_FORWARD_TO = " inbox@example.net ";
  is("one address elsewhere is", [forwardTarget(), isInboundConfigured()], ["inbox@example.net", true]);

  part("Only Resend is believed");
  is("signed with another secret: refused", (await POST(announce(A, { secret: Buffer.from("another-secret-another-secret") }))).status, 401);
  is("signed six minutes ago: refused", (await POST(announce(A, { at: Date.now() - 6 * 60_000 }))).status, 401);
  is("no signature at all", inboundSigned("{}", "msg_1", String(Math.floor(Date.now() / 1000)), null), false);
  is("nothing was read or sent for any of them", [reads.length, sent.length], [0, 0]);

  part("A message is sent on, once");
  const first = await POST(announce(A));
  is("answered", [first.status, await first.json()], [200, { ok: true, result: "sent" }]);
  const mail = sent[0]?.body;
  is("read with the reading key, sent with the sending key", [reads[0], sent[0]?.auth], [`Bearer re_test_reading_only /emails/receiving/${A}`, "Bearer re_test_sending_only"]);
  is("from the site's own address, in the writer's name", mail?.from, '"Jane Doe via Marktmorgen" <support@marktmorgen.com>');
  is("to the inbox, and a reply goes to the writer", [mail?.to, mail?.reply_to], [["inbox@example.net"], "jane@example.com"]);
  is("the subject is kept", mail?.subject, "Refund for my order");
  is("the text says who wrote, to which address, and what was left out", mail?.text, "From: Jane Doe <jane@example.com>\nTo: support@marktmorgen.com\nNot attached (see Resend, Emails, Receiving): elsewhere.png, huge.zip\n\nHello, I bought the guide twice.");
  is("the page is kept under the same lines", [mail?.html?.includes("From: Jane Doe &lt;jane@example.com&gt;"), mail?.html?.endsWith("<p>Hello, I bought the guide <b>twice</b>.</p>")], [true, true]);
  is("the file from Resend's host is attached, the others are not", mail?.attachments, [{ filename: "receipt.pdf", content: Buffer.from("hello").toString("base64") }]);
  is("marked as sent on, with a key that makes a repeat a no-op", [mail?.headers, sent[0]?.key], [{ "X-Marktmorgen-Forwarded": "1" }, `inbound-${A}`]);

  const again = await POST(announce(A));
  is("the same announcement again: acknowledged, nothing sent", [again.status, sent.length], [200, 1]);

  part("What is not sent on");
  const ours = await POST(announce(B));
  is("a message we sent on ourselves", [ours.status, await ours.json(), sent.length], [200, { ok: true, result: "skipped" }, 1]);
  const gone = await POST(announce("7ef9a417-02e9-4d39-ad75-9611e0fcc33c"));
  is("a message Resend does not have", [gone.status, await gone.json(), sent.length], [200, { ok: true, result: "skipped" }, 1]);
  const other = await POST(announce(A, { id: "msg_other", type: "email.delivered" }));
  is("an announcement of another kind", [other.status, sent.length], [200, 1]);
  const odd = await POST(announce("not-an-id", { id: "msg_odd" }));
  is("an id that is not one", [(await odd.json()).result, sent.length], ["skipped", 1]);

  part("A page with no text, and a Reply-To of its own");
  await POST(announce(C));
  const page = sent[1]?.body;
  is("the name, the reply address and a subject", [page?.from, page?.reply_to, page?.subject], ['"Sam via Marktmorgen" <support@marktmorgen.com>', "sam@work.example.org", "(no subject)"]);
  is("the page is read out as text", page?.text, "From: Sam <sam@example.org>\nTo: hello@marktmorgen.com\n\nOnly a page\ntwo lines & a sign");
  is("no files: none sent", page?.attachments, undefined);

  part("A message written to another site of ours");
  const elsewhere = await POST(announce(D));
  const theirs = sent[2]?.body;
  is("sent on to the same inbox", [(await elsewhere.json()).result, theirs?.to], ["sent", ["inbox@example.net"]]);
  is("from this site's own address, naming the domain it was written to", theirs?.from, '"Ana via hazelsong.com" <support@marktmorgen.com>');
  is("and the text says which address", theirs?.text, "From: Ana <ana@example.org>\nTo: support@hazelsong.com\n\nWhere do I paste the code?");

  part("When the provider confirms rate-limit non-acceptance");
  const retryId = newMailLike(A);
  failSending = true;
  const failed = await POST(announce(retryId, { id: "msg_retry" }));
  is("answered with a failure", failed.status, 500);
  failSending = false;
  const retried = await POST(announce(retryId, { id: "msg_retry" }));
  is("and the retry is heard", [retried.status, (await retried.json()).result, sent.length], [200, "sent", 4]);

  part("An answer written to a store's own address");
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  // A store that pays: what is sent on to its creator is one of its store emails for the billing month (lib/store-allowance-rules.ts).
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const before = await POST(announce(E, { id: "msg_before" }));
  is("with no domain set apart for creators, it is mail like any other", [(await before.json()).result, sent[4]?.body.to], ["sent", ["inbox@example.net"]]);
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  const answer = await POST(announce(newMailLike(E), { id: "msg_creator" }));
  // Distinct incoming emails are distinct intentions. Replaying the first
  // email ID must not fabricate a second successful provider delivery.
  const theirsNow = sent[5]?.body;
  is("it goes to the creator, and to nobody else", [(await answer.json()).result, theirsNow?.to], ["sent", ["ana@example.org"]]);
  is("from the store's own address, in the writer's name", theirsNow?.from, '"Lee via Harbor Kitchen" <harborkitchen@mail.marktmorgen.com>');
  is("a reply goes to the writer", theirsNow?.reply_to, "lee@example.org");
  is("and the text says who wrote, and to which address", theirsNow?.text, "From: Lee <lee@example.org>\nTo: harborkitchen@mail.marktmorgen.com\n\nIs the pie still on?");
  is("sent with the site's key, which may send from every domain of the account", sent[5]?.auth, "Bearer re_test_sending_only");
  process.env.RESEND_CREATORS_API_KEY = "re_test_creators_domain_only";
  await POST(announce(newMailLike(E), { id: "msg_own_key" }));
  is("or with a key held to that domain alone, when one is given", [sent[6]?.auth, sent[6]?.body.from], ["Bearer re_test_creators_domain_only", '"Lee via Harbor Kitchen" <harborkitchen@mail.marktmorgen.com>']);
  delete process.env.RESEND_CREATORS_API_KEY;
  refuseCreators = true;
  const narrowedId = newMailLike(E);
  const narrowed = await POST(announce(narrowedId, { id: "msg_narrowed" }));
  refuseCreators = false;
  is("if Resend refuses the creators' domain, the same email goes from the site's own address at once", [(await narrowed.json()).result, sent[7]?.body.from, sent[7]?.body.to, sent[7]?.key], ["sent", '"Lee via Harbor Kitchen" <onboarding@resend.dev>', ["ana@example.org"], `inbound-${narrowedId}:site`]);
  const nobody = await POST(announce(F));
  is("mail to a name that is no store's is dropped", [(await nobody.json()).result, sent.length], ["skipped", 8]);
  for (let i = 0; i < CREATOR_HOURLY; i += 1) await POST(announce(newMailLike(E), { id: `msg_flood_${i}` }));
  is("and one store is sent on only so many an hour", sent.length, 8 + CREATOR_HOURLY - 3);
  delete process.env.MARKETING_FROM_DOMAIN;
  part("Unknown HTTP acceptance never becomes a known rejection");
  const uncertainId = newMailLike(A), postsBefore = outboundPosts, sentBefore = sent.length;
  failureStatus = 500; failSending = true;
  const unknown = await POST(announce(uncertainId, { id: "msg_unknown" }));
  failSending = false;
  const unknownAgain = await POST(announce(uncertainId, { id: "msg_unknown" }));
  is("a possibly accepted message remains an explicit failure without another POST", [unknown.status, unknownAgain.status, outboundPosts - postsBefore, sent.length - sentBefore], [500, 500, 1, 0]);
  is("the original provider source remains available for reconciliation", (MAILS[uncertainId] as Record<string, unknown>).text, (MAILS[A] as Record<string, unknown>).text);

  part("Names and addresses");
  is("a name and an address", parseSender('"Doe, Jane" <jane@example.com>'), { name: "Doe, Jane", address: "jane@example.com" });
  is("a bare address", parseSender("jane@example.com"), { name: "", address: "jane@example.com" });
  is("nothing usable", parseSender("Jane <not an address>"), { name: "Jane", address: null });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
