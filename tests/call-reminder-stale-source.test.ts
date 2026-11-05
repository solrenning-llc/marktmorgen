/** Unknown recent work retries; the existing six-hour expiry must still free the bounded queue. */
import { sendCallReminders } from "@/lib/call-reminders";
import { REMINDER_QUEUE, reminderMember } from "@/lib/call-records";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const priorFetch = globalThis.fetch;
const priorSender = process.env.RESEND_API_KEY, priorStripe = process.env.STRIPE_SECRET_KEY;
const clock = Date.now;
const now = 1_793_800_000_000;
let reads = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com" || (init?.method ?? "GET") !== "GET") throw Error("Synthetic GETs only");
  reads++;
  return url.pathname === "/v1/checkout/sessions"
    ? new Response(JSON.stringify({ object: "list", data: [], has_more: false }))
    : new Response(JSON.stringify({ error: { message: "Synthetic permanent lookup failure" } }), { status: 500 });
}) as typeof fetch;

async function main() {
  Date.now = () => now;
  process.env.RESEND_API_KEY = "re_test_call_reminder_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_stand_in";
  redis.clear();
  await claimHandle("stalework@example.test", "stalework", "Synthetic reminder queue", "");
  await setStripeAccount("stalework@example.test", "acct_staleSynthetic", true);
  const store = { ...(await storeForEmail("stalework@example.test"))!, callsId: "staleworkdiary" };
  const find = async (handle: string) => handle === store.handle ? store : null;
  const run = () => sendCallReminders(find, now + 60_000, "https://example.test");
  const seed = (count: number, score: number, mark: "1" | "24" | "c", start: number) => {
    redis.run(["DEL", REMINDER_QUEUE]);
    reads = 0;
    for (let i = 0; i < count; i++) redis.run(["ZADD", REMINDER_QUEUE, score,
      reminderMember(store.callsId!, store.handle!, `cs_test_stale${String(i).padStart(20, "0")}`, mark, start)]);
  };

  part("A permanent individual lookup failure cannot monopolize the first 200 slots");
  seed(200, now - 3 * 86_400_000, "1", now - 3 * 86_400_000 + 3_600_000);
  redis.run(["ZADD", REMINDER_QUEUE, now - 1000,
    reminderMember("absentdiary", "absentstore", "cs_test_absent000000000000000000", "1", now + 1000)]);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await run());
  is("expired failures leave room for the later store, then the queue is empty", results.map(r => r.dropped), [200, 1, 0]);
  is("all 201 items were eventually removed", redis.run(["ZCARD", REMINDER_QUEUE]), 0);
  is("the failed provider reads stop after the first run", reads, 201);

  part("The existing retry window applies to every reminder kind");
  for (const mark of ["1", "24", "c"] as const) {
    seed(1, now - 6 * 3_600_000, mark, now + 86_400_000);
    await run();
    is(`${mark}: a failure exactly at the existing six-hour boundary is retained`, redis.run(["ZCARD", REMINDER_QUEUE]), 1);
    seed(1, now - 6 * 3_600_000 - 1, mark, now + 86_400_000);
    await run();
    is(`${mark}: an older individual failure expires`, redis.run(["ZCARD", REMINDER_QUEUE]), 0);
  }
  seed(1, now - 6 * 3_600_000 - 1, "1", now + 3_600_000);
  const failedStore = await sendCallReminders(async () => { throw Error("Synthetic unknown store"); }, now + 60_000, "https://example.test");
  is("an unknown store also expires only by the existing age rule", [failedStore.dropped, redis.run(["ZCARD", REMINDER_QUEUE]), reads], [1, 0, 0]);
}

main().finally(() => {
  Date.now = clock;
  globalThis.fetch = priorFetch;
  if (priorSender === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = priorSender;
  if (priorStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorStripe;
}).then(done).catch(error => { console.error(error); process.exit(1); });
