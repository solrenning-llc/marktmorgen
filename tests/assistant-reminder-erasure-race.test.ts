/**
 * Issue #4381 (Codex L, reproduced by Claude 2): an erasure that completes between keepAssistReminder's admission read
 * and its final writes. The keep must write nothing (no consent with the erased address, no queue member, no person
 * index) and answer "closed"; a keep that wins first is still removed by the erasure. Synthetic in-memory Redis only;
 * every outside call is answered by a stand-in, and no email leaves.
 */
import { claimHandle, ensureListId, ensureStatsId, setAssistReminder, setAssistantPlan, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { ASSIST_REMIND_VERSION } from "@/lib/assistant-reminder-rules";
import { assistReminderShown, keepAssistReminder } from "@/lib/assistant-reminder";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_assist_reminder_only";
process.env.RESEND_API_KEY = "re_test_assist_reminder_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "remind@example.com";
const ACCOUNT = "acct_fixture002";
const ADDRESS = "12 Oven Lane, Portland, OR 97201";
let n = 0;
const sessionId = () => `cs_test_assistremind${String((n += 1)).padStart(6, "0")}`;

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  await claimHandle(OWNER, "ovenshop", "Oven Shop", "Recipes for busy weeknights.");
  await setSubscription(OWNER, { customerId: "cus_OvenShop001", subscriptionId: "sub_OvenPlan01", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setAssistReminder(OWNER, { on: true });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_AssistRem002", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });
  await setRecovery(OWNER, { enabled: false, address: ADDRESS, asks: true });
  const store = (await storeForEmail(OWNER))!;

  part("An erasure that lands between the keep's admission read and its writes: nothing is written (issue #4381)");
  is("control: the box is shown", assistReminderShown(store, now), true);
  const session = sessionId();
  const email = "erased-4381@example.com";
  const original = redis.pipeline.bind(redis);
  let erased = false;
  let erasedOk: unknown = null;
  const hooked = (async (commands: (string | number)[][]) => {
    if (!erased && commands.some((c) => c[0] === "INCR" && String(c[1]).includes("assist-remind-store"))) {
      const reply = await original(commands);
      redis.pipeline = original;
      erased = true;
      erasedOk = (await erasePerson(store, email, { kind: "team", who: OWNER, role: "owner" })).ok;
      redis.pipeline = hooked;
      return reply;
    }
    return original(commands);
  }) as typeof redis.pipeline;
  redis.pipeline = hooked;
  let outcome: unknown;
  try {
    outcome = await keepAssistReminder({ store, session, email, version: ASSIST_REMIND_VERSION, now });
  } finally {
    redis.pipeline = original;
  }
  is("the erasure ran and completed", [erased, erasedOk], [true, true]);
  is("the keep answers closed: the erasure won", outcome, "closed");
  is("no consent holding the erased address", redis.run(["GET", `nl:assist:remind:${session}`]), null);
  const [queue] = await redis.pipeline([["ZRANGEBYSCORE", "nl:assist:remindq", "-inf", "+inf"]]);
  is("nothing queued for it", (queue as unknown[]).length, 0);

  part("A keep that wins first is still removed by the erasure that follows");
  const later = sessionId();
  const other = "kept-first-4381@example.com";
  is("kept", await keepAssistReminder({ store, session: later, email: other, version: ASSIST_REMIND_VERSION, now }), "kept");
  is("its consent is there", typeof redis.run(["GET", `nl:assist:remind:${later}`]), "string");
  is("the erasure completes", (await erasePerson(store, other, { kind: "team", who: OWNER, role: "owner" })).ok, true);
  is("and takes the consent away", redis.run(["GET", `nl:assist:remind:${later}`]), null);
  is("a new yes from that address afterwards is not kept either", await keepAssistReminder({ store, session: sessionId(), email: other, version: ASSIST_REMIND_VERSION, now }), "closed");

  part("A store with no list yet keeps nothing it could not check");
  const noList = { ...store, listId: null } as typeof store;
  is("closed, nothing written", await keepAssistReminder({ store: noList, session: sessionId(), email: "nolist-4381@example.com", version: ASSIST_REMIND_VERSION, now }), "closed");

  done();
}

void main();
