/**
 * Codex L on #3926 (MEDIUM, lib/inbound-mail.ts:314-316), RED before the fix: a message's "counted" mark is taken
 * with SET NX, then the store's hourly inbound allowance is counted. When the SET lands but its answer is lost (and
 * so is the read-back), the try answers "retry" without counting; Resend announces again, the next try finds the
 * mark taken and forwards without counting at all. With the store's hour already full, that message goes on anyway.
 * The fix takes the mark and the count in one script, and keeps the count's verdict in the mark: a lost answer
 * leaves both done or both undone, and the next try reads the same verdict. Synthetic only.
 */
import { CREATOR_HOURLY, forwardInbound } from "@/lib/inbound-mail";
import { claimHandle, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const RECEIVED = /^\/emails\/receiving\/([0-9a-f-]{36})(\/attachments)?$/;
const writtenTo = "harborkitchen@mail.marktmorgen.com";
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

/** The next pipeline that touches a message's counted mark runs, and its answer is lost; so is the read-back of the mark right after it. */
let loseNext = false;
const original = redis.pipeline.bind(redis);
let dropFollowing = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const touchesMark = commands.some((command) => command.some((part) => typeof part === "string" && part.startsWith("nl:inbound:counted:")));
  if (dropFollowing > 0 && touchesMark && commands[0]?.[0] === "GET") {
    dropFollowing -= 1;
    throw new Error("the answer was lost");
  }
  dropFollowing = 0;
  if (loseNext && touchesMark) {
    loseNext = false;
    await original(commands);
    dropFollowing = 1;
    throw new Error("the answer was lost");
  }
  return original(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_sending_only";
  process.env.RESEND_INBOUND_API_KEY = "re_test_reading_only";
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("a-stand-in-secret-for-tests-only").toString("base64")}`;
  process.env.SUPPORT_FORWARD_TO = "inbox@example.net";
  process.env.MARKETING_FROM_DOMAIN = "mail.marktmorgen.com";
  redis.clear();
  await claimHandle("ana@example.org", "harborkitchen", "Harbor Kitchen", "");
  await setSubscription("ana@example.org", { customerId: "cus_Harbor0001", subscriptionId: "sub_Harbor0001", active: true, period: paidPeriod() });
  const id = (n: number) => `5af9a417-02e9-4d39-ad75-${n.toString(16).padStart(12, "0")}`;

  part("A message whose mark answer is lost, inside the hour's allowance, is sent once and counted once");
  loseNext = true;
  is("the try whose answer was lost is a retry", await forwardInbound(id(0)), "retry");
  is("Resend's next announcement sends it", await forwardInbound(id(0)), "sent");
  const more: string[] = [];
  for (let i = 1; i < CREATOR_HOURLY; i += 1) more.push(await forwardInbound(id(i)));
  is(`the other ${CREATOR_HOURLY - 1} messages of the hour are sent`, more.filter((r) => r !== "sent").length, 0);
  is("one more message that hour is past the allowance", await forwardInbound(id(CREATOR_HOURLY)), "skipped");

  part("Past the allowance, a message whose mark answer is lost is never sent on its retry");
  const before = posted;
  loseNext = true;
  is("the try whose answer was lost is a retry", await forwardInbound(id(CREATOR_HOURLY + 1)), "retry");
  is("Resend's next announcement is skipped, as an uncounted message past the hour's allowance would be", await forwardInbound(id(CREATOR_HOURLY + 1)), "skipped");
  is("nothing more was sent on", posted, before);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
