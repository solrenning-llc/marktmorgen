/**
 * A message to a store's own address is forwarded only once its count's decision is written down (Codex N1's and X6's
 * LOW on #3926). forwardInbound takes the message's mark, counts it against the store's hour and writes "admitted" or
 * "refused" on the mark for a retry (SET ... XX). That write's reply was never read: a write that did not land still
 * forwarded the message, while every retry read an undecided mark. Now an admission not confirmed by Redis ("OK") is a
 * retry, nothing is sent on it, and a later try with a known write goes on.
 *
 * Synthetic only: Resend stand-in and the Redis stub.
 */
import { forwardInbound } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const RECEIVED = /^\/emails\/receiving\/([0-9a-f-]{36})(\/attachments)?$/;
const writtenTo = "quietdock@mail.marktmorgen.com";
let posted = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST" && url.pathname === "/emails") {
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
  await claimHandle("dock@example.org", "quietdock", "Quiet Dock", "");
  await setSubscription("dock@example.org", { customerId: "cus_QuietDock01", subscriptionId: "sub_QuietDock01", active: true, period: paidPeriod() });
  const id = "5af9a417-02e9-4d39-ad75-000000000001";
  const mark = `nl:inbound:counted:${id}`;

  const real = redis.pipeline.bind(redis);
  let dropDecision = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const one = commands.length === 1 ? commands[0] : null;
    // The decision's write on this message's mark answers with no confirmation (a lost or odd reply), once.
    if (dropDecision && one && one[0] === "SET" && one[1] === mark && one.includes("XX")) {
      dropDecision = false;
      return [null];
    }
    return real(commands);
  }) as typeof redis.pipeline;

  part("The admission's write is not confirmed");
  is("not forwarded: a retry", await forwardInbound(id), "retry");
  is("and nothing was sent", posted, 0);

  part("Tried again while the mark is undecided");
  is("still a retry, never sent on an undecided mark", await forwardInbound(id), "retry");
  is("nothing sent", posted, 0);

  part("Once the mark lapses, the next try counts again and goes on");
  await real([["DEL", mark]]);
  is("forwarded once its decision is written down", await forwardInbound(id), "sent");
  is("sent once", posted, 1);

  redis.pipeline = real;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
