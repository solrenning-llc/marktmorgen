/**
 * A busy day's email is not lost when today's channels cannot be read (lib/stats-report.ts, maybeBusyAlert).
 * Found by Cloud M's review of claude3/audit/d-stats-today-exact (11 November 2026): sourcesToday now throws on a
 * reply of another shape (rule 24), and maybeBusyAlert read it after taking the day's once-only mark, so the throw
 * left the mark taken and no email went that day. Which channel brought most visits is one optional sentence: when it
 * cannot be read, that sentence is left out (never a channel made up) and the email still goes, once.
 * Synthetic only.
 */
import { recordHit } from "@/lib/stats";
import { maybeBusyAlert } from "@/lib/stats-report";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to?: string; text?: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body ?? "{}")) as { to?: string; text?: string });
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

// Today's channels (the day's HGETALL) answer in another shape; every other read is as Redis keeps it.
let oddChannels = false;
const run = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const replies = await run(commands);
  if (!oddChannels || !commands.some((c) => c[0] === "HGETALL" && /^nl:stats:/.test(String(c[1])))) return replies;
  return commands.map((c, i) => (c[0] === "HGETALL" ? "lots" : replies[i]));
};

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const TODAY = Date.UTC(2026, 10, 11, 15);

async function main() {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_numbers_three_only";
  const OWNER = "busyunknown@example.com";
  await claimHandle(OWNER, "busyunknown", "Busy Unknown", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_BusyUnk001", subscriptionId: "sub_BusyUnk001", active: true, period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  for (let i = 0; i < 64; i += 1) await recordHit(store, { kind: "view", source: "tiktok", ip: `198.51.100.${i}`, userAgent: PHONE }, TODAY);

  oddChannels = true;
  const sent = await maybeBusyAlert(store, 64, TODAY);
  oddChannels = false;
  is("a busy day whose channels cannot be read is still written about", [sent, emails.length], [true, 1]);
  is("without naming any channel", /Most of them came from/.test(emails[0]?.text ?? ""), false);
  is("and only once that day", [await maybeBusyAlert(store, 128, TODAY), emails.length], [false, 1]);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
