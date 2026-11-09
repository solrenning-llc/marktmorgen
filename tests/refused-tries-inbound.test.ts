/**
 * Mail sent on from the site's own addresses (lib/inbound-mail.ts,
 * forwardInbound, behind app/api/mail/inbound) when the sender refuses it for
 * certain every time (rule 30; Claude 5's MEDIUM on the -v3 branches, 9
 * November 2026).
 *
 * A refusal is answered with a failure, so Resend makes the announcement
 * again; and a refusal can come after the store's figure was taken (a stop
 * before the request since #3377, a 4xx after it: a 422 here). Each of
 * Resend's retries took one more of the store's emails. Each refusal is now
 * counted (lib/refused-tries.ts); the third is acknowledged ("refused"), so
 * Resend stops. Resend is a stand-in for `fetch`; no real email is sent.
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

const MAILS: Record<string, unknown> = {
  [TO_STORE]: {
    object: "email", id: TO_STORE, from: "Lee <lee@example.org>",
    to: ["harborkitchen@mail.marktmorgen.com"], received_for: ["harborkitchen@mail.marktmorgen.com"],
    reply_to: [], subject: "Re: The autumn menu", text: "Is the pie still on?", headers: {},
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

  part("To a store's own address, a sender that refuses for certain on every one of Resend's retries");
  senderAnswers.set("Re: The autumn menu", () => answerOf(422));
  const usedBefore = await allowanceUsed(store, "email");
  const answers: unknown[] = [];
  // Resend makes the announcement again after each failure (eight tries over about a day); six here.
  for (let n = 0; n < 6; n += 1) answers.push(await answered(await POST(announce(TO_STORE, "msg_store"))));
  is("the sender is asked at most REFUSED_TRIES (3) times", postsOf("Re: The autumn menu"), 3);
  is("the store's figure is taken at most 3 times", (await allowanceUsed(store, "email")) - usedBefore, 3);
  is("the first two are answered with a failure, so Resend makes it again", answers.slice(0, 2), [[500, { ok: false }], [500, { ok: false }]]);
  is("the third is acknowledged, said as refused: Resend stops", answers[2], [200, { ok: true, result: "refused" }]);
  is("a repeat after it is heard and sends nothing", answers.slice(3).every((a) => (a as [number])[0] === 200), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
