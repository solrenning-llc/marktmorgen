/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/quiet-sales.ts checkQuiet, line 97:
 *   if (await weeklyOff(store.handle)) return "skipped";
 * with weeklyOff (lib/stats-report.ts:291-295, outside this range): `Number(member) === 1`. A SISMEMBER answered
 * in an unknown shape is "has not stopped these emails": a creator who pressed the stop link in the email
 * ("To stop these emails, the busy-day one and the weekly one") is written to again. The same helper decides
 * lib/store-alerts.ts:220 and lib/stats-report.ts:593 (siblings, by reading).
 */
import { checkQuiet } from "@/lib/quiet-sales";
import { setWeeklyOff } from "@/lib/stats-report";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_quiet_coverage";
process.env.RESEND_API_KEY = "re_test_quiet_coverage";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const now = Date.UTC(2026, 9, 20, 12);
const day = 86_400_000;
const store = { handle: "harbor", previousHandles: [], name: "Harbor", email: "owner@example.com", stripeAccountId: "acct_test", subscriptionActive: true } as unknown as Store;
const times = Array.from({ length: 30 }, (_, i) => now - (20 + i) * day);
const page = { data: times.map((at, i) => ({ id: `cs_${i}`, created: at / 1000, status: "complete", payment_status: "paid", metadata: { store: "harbor" } })), has_more: false };
let emails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") { emails++; return new Response('{"id":"test"}'); }
  return new Response(JSON.stringify(page));
}) as typeof fetch;
const original = redis.pipeline.bind(redis);

async function main() {
  part("Healthy control: the creator pressed stop; a quiet stretch sends nothing");
  redis.clear();
  await setWeeklyOff("harbor", true);
  is("skipped", await checkQuiet(store, now), "skipped");
  is("no email", emails, 0);

  part("DEFECT: the same creator, the SISMEMBER of the stop list answered in an unknown shape");
  for (const [label, reply] of [["no reply", () => []], ["text", () => ["yes"]], ["an object", () => [{}]]] as const) {
    redis.clear();
    await setWeeklyOff("harbor", true);
    emails = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "SISMEMBER" && commands[0][2] === "harbor") return reply();
      return original(commands);
    }) as typeof redis.pipeline;
    const outcome = await checkQuiet(store, now);
    redis.pipeline = original;
    is(`DEFECT (${label}): the quiet-sales email is sent to a creator who stopped it`, [outcome, emails], ["sent", 1]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
