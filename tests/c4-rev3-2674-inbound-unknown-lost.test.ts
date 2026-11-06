/**
 * Review proof (#2674): a buyer's email to a creator's store address, when
 * the creator-inbound counter cannot be read (Redis threw), is "skipped": the
 * webhook answers 200 and keeps its seen marker, so Resend never retries and
 * the message never reaches the creator. Unknown must be "retry".
 */
import { forwardInbound } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "9ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const sent: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && (init?.method ?? "GET") === "POST") { sent.push(init?.body); return new Response(JSON.stringify({ id: "e" })); }
  if (url.pathname === `/emails/receiving/${ID}`) return new Response(JSON.stringify({ object: "email", id: ID, from: "Lee <lee@example.org>", to: ["harborkitchen@mail.marktmorgen.com"], received_for: ["harborkitchen@mail.marktmorgen.com"], reply_to: [], subject: "Re: menu", text: "Is the pie still on?", headers: {} }));
  if (url.pathname.endsWith("/attachments")) return new Response(JSON.stringify({ object: "list", has_more: false, data: [] }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const real = redis.pipeline.bind(redis);
  let thrown = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => String(c[1]).startsWith("nl:rl:creator-inbound:"))) { thrown++; throw new Error("Redis timed out"); }
    return real(commands);
  }) as typeof redis.pipeline;
  part("creator-inbound counter unknown");
  const result = await forwardInbound(ID);
  is("the counter threw once", thrown, 1);
  is("unknown is never skipped (200 + seen marker kept = message lost); retry (500) or send", result === "skipped", false);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
