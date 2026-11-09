/**
 * Mail sent on from the site's own addresses (lib/inbound-mail.ts,
 * forwardInbound, behind app/api/mail/inbound) under a sender whose answer is
 * not known (rule 30, a sibling of 283 [HG2] unit 1's sendEmailOutcome).
 *
 * Before, a send that may have gone (a server error, or a network error after
 * the request) was answered with a 500 and the announcement let go of, so
 * Resend made it again: each repeat inside a day took another of the store's
 * emails, and a repeat after the day sent the message on a second time. An
 * uncertain send is now acknowledged (200, result "uncertain"), the
 * announcement kept as heard, and nothing is asked again; only a certain
 * refusal is still answered with a failure, so Resend's retry is heard.
 * Resend is played by a stand-in for `fetch`; no real email is sent. Checked:
 *
 *   - to a store's own address, a 500 from the sender: answered 200, the
 *     announcement kept, the repeat sends nothing and takes no second email
 *     from the store's figure;
 *   - a thrown request (network error): the same, to the site's inbox;
 *   - Resend's retries a day later (made only of what was not acknowledged):
 *     nothing is sent on a second time;
 *   - a 422 (a certain refusal): answered 500, and the retry is heard and
 *     sends (control: unchanged behavior).
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mail/inbound/route";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET_BYTES = Buffer.from("a-stand-in-secret-for-tests-only");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const TO_STORE = "4ef9a417-02e9-4d39-ad75-9611e0fcc331";
const TO_SITE = "4ef9a417-02e9-4d39-ad75-9611e0fcc332";
const REFUSED = "4ef9a417-02e9-4d39-ad75-9611e0fcc333";

const MAILS: Record<string, unknown> = {
  [TO_STORE]: {
    object: "email", id: TO_STORE, from: "Lee <lee@example.org>",
    to: ["harborkitchen@mail.marktmorgen.com"], received_for: ["harborkitchen@mail.marktmorgen.com"],
    reply_to: [], subject: "Re: The autumn menu", text: "Is the pie still on?", headers: {},
  },
  [TO_SITE]: {
    object: "email", id: TO_SITE, from: "Jane <jane@example.com>",
    to: ["support@marktmorgen.com"], received_for: ["support@marktmorgen.com"],
    reply_to: [], subject: "Refund for my order", text: "Hello.", headers: {},
  },
  [REFUSED]: {
    object: "email", id: REFUSED, from: "Sam <sam@example.org>",
    to: ["hello@marktmorgen.com"], reply_to: [], subject: "Hi", text: "x", headers: {},
  },
};

/** Every message the sender was asked to send, by subject, taken or not. */
const posts: string[] = [];
/** How the sender answers one subject, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    const subject = String((JSON.parse(String(init?.body)) as { subject: string }).subject);
    posts.push(subject);
    const special = senderAnswers.get(subject);
    if (special) return special();
    return new Response(JSON.stringify({ id: `e_${posts.length}` }));
  }
  if (url.hostname === "api.resend.com") {
    if (/\/attachments$/.test(url.pathname)) return new Response(JSON.stringify({ object: "list", has_more: false, data: [] }));
    const one = url.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (one && MAILS[one[1]]) return new Response(JSON.stringify(MAILS[one[1]]));
    return new Response("{}", { status: 404 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function announce(emailId: string, id: string): NextRequest {
  const at = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "email.received", created_at: "2026-10-03T00:00:00.000Z", data: { email_id: emailId, from: "x", to: ["y"], subject: "z" } });
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${at}.${body}`).digest("base64");
  return new NextRequest("https://marktmorgen.com/api/mail/inbound", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "svix-id": id, "svix-timestamp": at, "svix-signature": `v1,${signature}` },
    body,
  });
}

const postsOf = (subject: string) => posts.filter((s) => s === subject).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });
const answered = async (response: Response) => [response.status, await response.json()];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("ana@example.org"))!;
  const seen = (id: string) => redis.keys().includes(`nl:inbound:seen:${id}`);

  part("To a store's own address, a 500 from the sender");
  senderAnswers.set("Re: The autumn menu", () => answerOf(500));
  const usedBefore = await allowanceUsed(store, "email");
  const first = await POST(announce(TO_STORE, "msg_store"));
  is("acknowledged, said to be uncertain: Resend does not make it again", await answered(first), [200, { ok: true, result: "uncertain" }]);
  is("the announcement is kept as heard", seen("msg_store"), true);
  const repeat = await POST(announce(TO_STORE, "msg_store"));
  is("a repeat of it is acknowledged and sends nothing", [repeat.status, postsOf("Re: The autumn menu")], [200, 1]);
  is("one of the store's emails is taken, once", (await allowanceUsed(store, "email")) - usedBefore, 1);

  part("To the site's inbox, a thrown request");
  senderAnswers.set("Refund for my order", () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  const thrown = await POST(announce(TO_SITE, "msg_site"));
  is("acknowledged, said to be uncertain", await answered(thrown), [200, { ok: true, result: "uncertain" }]);
  is("the announcement is kept as heard", seen("msg_site"), true);

  part("Resend's retries, a day later");
  senderAnswers.clear();
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 3_600_000;
  try {
    // Resend makes an announcement again, over the following hours and days,
    // only while it was not acknowledged with a 2xx; by then the day the
    // announcement and the sender's key are kept has passed.
    for (const [emailId, id, answer] of [[TO_STORE, "msg_store", first.status], [TO_SITE, "msg_site", thrown.status]] as const) {
      if (answer >= 300) await POST(announce(emailId, id));
    }
    is("nothing is sent on a second time", [postsOf("Re: The autumn menu"), postsOf("Refund for my order")], [1, 1]);
  } finally {
    Date.now = realNow;
  }

  part("A certain refusal (control)");
  senderAnswers.set("Hi", () => answerOf(422));
  const refused = await POST(announce(REFUSED, "msg_refused"));
  is("answered with a failure, so Resend makes it again", refused.status, 500);
  is("the announcement is let go of", seen("msg_refused"), false);
  senderAnswers.clear();
  const retried = await POST(announce(REFUSED, "msg_refused"));
  is("and the retry is heard and sends", [await answered(retried), postsOf("Hi")], [[200, { ok: true, result: "sent" }], 2]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
