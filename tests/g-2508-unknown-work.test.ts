/** Independent G review: actual worker/readers and synthetic boundaries only. */
import { sendCallReminders } from "@/lib/call-reminders";
import { planReminders, REMINDER_QUEUE } from "@/lib/call-records";
import { addProduct, claimHandle, setProductCall, setStripeAccount, storeForEmail, storeForHandle } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "g2508@example.test", handle = "g2508store";
const originalPipeline = redis.pipeline.bind(redis), priorFetch = globalThis.fetch;
const oldSender = process.env.RESEND_API_KEY, oldStripe = process.env.STRIPE_SECRET_KEY;
let mode = "list-error", network = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com" || (init?.method ?? "GET") !== "GET") throw Error("No sending or external request allowed");
  network++;
  if (url.pathname === "/v1/checkout/sessions" && mode === "lookup-error") return new Response(JSON.stringify({ data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: "Synthetic provider unavailable" } }), { status: 500 });
}) as typeof fetch;

async function main() {
  process.env.RESEND_API_KEY = "re_test_g2508_synthetic_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_g2508_synthetic_only";
  redis.clear();
  await claimHandle(owner, handle, "Synthetic G review", "");
  await setStripeAccount(owner, "acct_g2508synthetic", true);
  const made = await addProduct(owner, "Synthetic call", "", "29", null);
  if (!made.ok) throw Error("control product");
  const setup = { kind: "weekly", minutes: 60, tz: "UTC", weekly: Array.from({ length: 7 }, () => [[540,1020]]), noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.test/meeting", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
  if (!(await setProductCall(owner, made.product.id, setup)).ok) throw Error("control call");
  const store = (await storeForEmail(owner))!;
  if (!store.callsId) throw Error("control diary");
  const session = "cs_test_g2508synthetic0001";
  const seed = async () => {
    redis.pipeline = originalPipeline;
    redis.run(["DEL", REMINDER_QUEUE]); network = 0;
    await planReminders(store.callsId!, handle, session, Date.now() + 1800000, Date.now() - 7200000);
    if (redis.run(["ZCARD", REMINDER_QUEUE]) !== 1) throw Error("control due item");
  };
  const run = (find = storeForHandle) => sendCallReminders(find, Date.now() + 60000, "https://example.test");
  part("Confirmed absence still removes obsolete work; failed reads preserve it");
  await seed();
  is("a store explicitly known absent is cleaned up", [await run(async () => null), redis.run(["ZCARD", REMINDER_QUEUE]), network], [{ reminded: 0, confirmed: 0, dropped: 1 }, 0, 0]);
  await seed(); mode = "list-error";
  is("fresh work survives provider list HTTP500", [await run(), redis.run(["ZCARD", REMINDER_QUEUE])], [{ reminded: 0, confirmed: 0, dropped: 0 }, 1]);
  for (const fault of ["pointer-throw", "pointer-partial", "record-partial"]) {
    await seed(); mode = "list-error";
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "GET" && (fault.startsWith("pointer") ? c[1] === `nl:store:handle:${handle}` : String(c[1]).startsWith("nl:store:") && c[1] !== `nl:store:handle:${handle}`))) {
        if (fault.endsWith("throw")) throw Error("Synthetic Redis read failure");
        return [];
      }
      return originalPipeline(commands);
    };
    let result: unknown;
    try { result = await run(); } catch { result = "unknown/error"; }
    const remaining = redis.run(["ZCARD", REMINDER_QUEUE]);
    console.log("OBSERVED store failure", JSON.stringify({ fault, result, remaining, network }));
    is(`${fault}: unknown store read preserves its due reminder`, remaining, 1);
  }
  await seed(); mode = "lookup-error";
  const result = await run();
  console.log("OBSERVED individual provider failure", JSON.stringify({ result, remaining: redis.run(["ZCARD", REMINDER_QUEUE]), network }));
  is("missing list member followed by individual GET500 is not proof of unpaid/gone", redis.run(["ZCARD", REMINDER_QUEUE]), 1);
  is("individual lookup case reached only the two synthetic GETs", network, 2);
}
main().finally(() => {
  redis.pipeline = originalPipeline; globalThis.fetch = priorFetch;
  if (oldSender === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldSender;
  if (oldStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = oldStripe;
}).then(done).catch(error => { console.error(error); process.exit(1); });
