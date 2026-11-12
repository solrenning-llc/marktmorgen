/**
 * A notice's link acts only for the operator (issue #4036). The support email
 * that carries `/takedown/<token>` is sent with Reply-To set to the reporter and
 * says "Reply to this email to answer the sender", so a reply that quotes it
 * hands the token to the reporter. The token alone must not take a store down:
 * the route answers anybody but the operator (DEMO_STUDIO_ADMIN, the person who
 * runs the site, as lib/search-console.ts isOperator reads it) exactly as it
 * answers an unknown token, and the page that shows the notice, with the
 * reporter's name, address and telephone and the buttons, is not found for them.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/takedown/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addStoreLink, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReport } from "@/lib/takedown-rules";
import { fileReport } from "@/lib/takedown";
import { isOperator } from "@/lib/search-console";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const ORIGIN = "https://marktmorgen.com";
type Sent = { to: string[] | string; subject: string; text: string; reply_to?: string };
const sent: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const NOTICE = {
  kind: "other",
  url: `${ORIGIN}/@operatoronly`,
  work: "Synthetic notice for a test, nothing real here.",
  name: "Mallory Reporter",
  email: "mallory@example.com",
  contact: "",
  signature: "Mallory Reporter",
  goodFaith: true,
  accurate: true,
};

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_takedown_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_takedown_only_a_stand_in";
  const operator = process.env.DEMO_STUDIO_ADMIN ?? "";
  if (!isOperator(operator)) throw new Error("setup: the test environment names an operator (tests/test-config.mjs)");

  const owner = "operatoronly@example.com";
  await claimHandle(owner, "operatoronly", "Operator Only", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestOperatorOnly1", true);
  await setSubscription(owner, { customerId: "cus_OperatorOnly1", subscriptionId: "sub_OperatorOnly1", active: true, period: paidPeriod() });
  const link = await addStoreLink(owner, "A link", "https://example.com/a-link");
  if (!link.ok) throw new Error("setup: link");
  const read = readReport(NOTICE);
  if (!read.ok) throw new Error("setup: notice");
  const filed = await fileReport(read.report, "203.0.113.9", ORIGIN);
  if (filed !== "sent") throw new Error(`setup: filed ${filed} ${JSON.stringify(read.report)}`);
  const mail = sent[0];
  const token = mail.text.match(/\/takedown\/([0-9a-f]{48})/)?.[1] ?? "";
  if (!token) throw new Error("setup: the token in the support email");
  const suspended = async () => Boolean((await storeForEmail(owner))?.suspended);

  const act = async (cookie: string | null) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN, Host: "marktmorgen.com" };
    if (cookie) headers.Cookie = `${SESSION_COOKIE}=${cookie}`;
    const response = await POST(new NextRequest(`${ORIGIN}/api/takedown`, {
      method: "POST", headers, body: JSON.stringify({ token, action: { type: "store", on: true } }),
    }));
    return { status: response.status, body: (await response.json()) as unknown };
  };

  part("The support email's token reaches the reporter on a quoting reply");
  is("the email replies to the reporter and carries the token", [mail.reply_to, mail.text.includes(`/takedown/${token}`)], ["mallory@example.com", true]);

  part("The token alone does nothing");
  is("no session: answered as an unknown token", await act(null), { status: 404, body: { ok: false, error: "gone" } });
  is("and the store is still up", await suspended(), false);
  const stranger = await openSession("mallory@example.com");
  is("the reporter signed in: answered as an unknown token", await act(stranger), { status: 404, body: { ok: false, error: "gone" } });
  const creator = await openSession("another-creator@example.com");
  is("another creator signed in: answered as an unknown token", await act(creator), { status: 404, body: { ok: false, error: "gone" } });
  is("the store is still up after all three", await suspended(), false);

  part("The operator acts");
  const mine = await openSession(operator);
  const acted = await act(mine);
  is("the operator's session switches the store off", [acted.status, (acted.body as { ok?: unknown }).ok], [200, true]);
  is("and it is off", await suspended(), true);

  part("The page shows the notice only to the operator");
  const page = readFileSync("app/takedown/[token]/page.tsx", "utf8");
  const body = page.slice(page.indexOf("export default async function TakedownPage"));
  const check = body.search(/isOperator\(/);
  const opens = body.indexOf("openReport(");
  is("the page reads the session and checks the operator", [/emailForSession\(/.test(body), check >= 0], [true, true]);
  is("before it opens the notice", check >= 0 && opens >= 0 && check < opens, true);
  is("and a non-operator gets notFound() before openReport", /if \(!isOperator\([^)]*\)\) notFound\(\);/.test(body.slice(0, opens)), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
