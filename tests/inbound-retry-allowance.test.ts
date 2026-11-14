/**
 * Mail-queue hunt (RED before the fix): a message written to a store's own address takes one of the store's hourly
 * inbound allowance (CREATOR_HOURLY) before it is sent on (lib/inbound-mail.ts forwardInbound). When
 * the send itself fails (Resend answers 429 to every try, a documented non-acceptance), forwardInbound answers "retry", the route lets go of the
 * announcement and Resend makes it again; but every one of those tries takes the allowance again. The
 * invariant tests/inbound-files-unknown.test.ts already states for list failures ("the allowance still
 * counts each message once") does not hold for send failures, so an outage of the sending side turns
 * later messages that hour into "skipped" (answered 200, never offered again: lost). Synthetic only.
 */
import { CREATOR_HOURLY, forwardInbound } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const RECEIVED = /^\/emails\/receiving\/([0-9a-f-]{36})(\/attachments)?$/;
const writtenTo = "harborkitchen@mail.marktmorgen.com";
let sendFails = false;
let posted = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
    if (sendFails) return new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429 });
    posted += 1;
    return new Response(JSON.stringify({ id: `e${posted}` }));
  }
  const received = url.hostname === "api.resend.com" ? RECEIVED.exec(url.pathname) : null;
  if (received?.[2]) return new Response(JSON.stringify({ object: "list", has_more: false, data: [] }));
  if (received) {
    return new Response(JSON.stringify({ object: "email", id: received[1], from: "jane@example.com", to: [writtenTo], received_for: [writtenTo], reply_to: [], subject: "Hi", text: "Hello.", headers: {} }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  redis.clear();
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const id = (n: number) => `4ef9a417-02e9-4d39-ad75-${n.toString(16).padStart(12, "0")}`;

  part("Control: the send refused (429, not accepted) is a retry");
  sendFails = true;
  const tries: string[] = [];
  for (let i = 0; i < 4; i += 1) tries.push(await forwardInbound(id(0)));
  is("four tries of one message while Resend answers 429: each a retry", tries.every((t) => t === "retry"), true);

  part("Retries of one message do not spend the store's hourly allowance");
  sendFails = false;
  is("the same message goes on once Resend answers", await forwardInbound(id(0)), "sent");
  const more: string[] = [];
  for (let i = 1; i < CREATOR_HOURLY; i += 1) more.push(await forwardInbound(id(i)));
  is(`${CREATOR_HOURLY} different messages that hour are all sent (each counted once)`, more.filter((r) => r !== "sent").length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
