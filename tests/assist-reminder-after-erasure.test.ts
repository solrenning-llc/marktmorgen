/**
 * The checkout reminder's yes is never kept for a store whose erasure began or ended while the checkout was being
 * opened (Codex L-20261121-0151, MEDIUM). Both checkout routes read the store, open the checkout at the provider and
 * only then call keepAssistReminder with the store they read; it waits on its daily limit and then writes the buyer's
 * address (nl:assist:remind:<checkout>), the queue member (nl:assist:remindq) and the one-way index erasure finds it
 * by (nl:assist:remindwho:<statsId>:<hash>). Written as four plain commands, a store erased meanwhile got all three
 * back, the buyer's address under a store that no longer exists. Now they are one step fenced on the store being live
 * (lib/live-fence.ts's rule): its erasing mark absent and its id key still holding this very store's ref.
 *
 * What is checked, synthetic data only (Stripe, the sender and the model are never reached):
 *   - erased (closeStoreRecord, the closing walk's last step) before the keep, as when it lands while the checkout
 *     opens: "closed", and no consent, no queue member, no index;
 *   - its erasing mark set while the daily limit is read: the same;
 *   - its id key repointed to another ref (an account move) while the daily limit is read: the same;
 *   - an answer of the fenced step that does not read (rule 24): "closed", never "kept", and it never throws;
 *   - control: a live store keeps exactly one consent, one queue member and one index, as before.
 */
import { claimHandle, ensureListId, ensureStatsId, ERASING_KEY, closeStoreRecord, erasingField, setAssistReminder, setAssistantPlan, setRecovery, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { ASSIST_REMIND_KEEP_SECONDS, ASSIST_REMIND_VERSION } from "@/lib/assistant-reminder-rules";
import { assistReminderShown, keepAssistReminder } from "@/lib/assistant-reminder";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_assist_reminder_erasure_only";
process.env.RESEND_API_KEY = "re_test_assist_reminder_erasure_only";

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`no network in this test: ${String(input)}`);
}) as typeof fetch;

const OWNER = "remind-erasure@example.test";
const ACCOUNT = "acct_fixture003";
const ADDRESS = "12 Oven Lane, Portland, OR 97201";
type Command = (string | number)[];

/** Something to run in place of the next pipeline call keepAssistReminder makes (its daily limit's count), or a reply to put in place of its fenced step. */
const hook: { before: (() => Promise<void>) | null; reply: unknown[] | null } = { before: null, reply: null };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = async (batch: Command[]) => {
  const run = hook.before;
  if (run) {
    hook.before = null;
    await run();
  }
  if (hook.reply && batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).includes("assist-reminder")) return hook.reply;
  return pipeline(batch);
};

let n = 0;
const sessionId = () => `cs_test_assisterase${String((n += 1)).padStart(6, "0")}`;

async function liveStore(now: number): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "ovenerase", "Oven Erase", "Recipes for busy weeknights.");
  await setSubscription(OWNER, { customerId: "cus_OvenErase01", subscriptionId: "sub_OvenErase1", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setAssistReminder(OWNER, { on: true });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_AssistErase1", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });
  await setRecovery(OWNER, { enabled: false, address: ADDRESS, asks: true });
  return (await storeForEmail(OWNER))!;
}

/** Every key of the reminder's three families, and the queue's members. */
async function residue(): Promise<{ consents: number; who: number; queue: number }> {
  const scan = (match: string) => (redis.run(["SCAN", "0", "MATCH", match, "COUNT", 100_000]) as [string, string[]])[1].length;
  const queue = (redis.run(["ZRANGEBYSCORE", "nl:assist:remindq", "-inf", "+inf"]) as unknown[]).length;
  return { consents: scan("nl:assist:remind:*"), who: scan("nl:assist:remindwho:*"), queue };
}

const NONE = { consents: 0, who: 0, queue: 0 };

async function main(): Promise<void> {
  const now = Date.now();
  const keep = (store: Store, session = sessionId()) => keepAssistReminder({ store, session, email: "ana@example.com", version: ASSIST_REMIND_VERSION, now });

  part("Control: a live store keeps its buyer's yes, once");
  {
    const store = await liveStore(now);
    is("the box is offered on this store", assistReminderShown(store, now), true);
    const session = sessionId();
    is("kept", await keep(store, session), "kept");
    is("one consent, one index, one queue member", await residue(), { consents: 1, who: 1, queue: 1 });
    const ttl = Number(redis.run(["TTL", `nl:assist:remind:${session}`]));
    is("the consent goes by itself three days after the checkout opened", ttl > ASSIST_REMIND_KEEP_SECONDS - 60 && ttl <= ASSIST_REMIND_KEEP_SECONDS, true);
  }

  part("Erased while the checkout was opening: nothing comes back");
  {
    const read = await liveStore(now);
    is("the store's record went with its erasure", await closeStoreRecord(read), true);
    is("the route's old store object: not kept", await keep(read), "closed");
    is("no consent, no index, no queue member", await residue(), NONE);
  }

  part("Its erasure began while the daily limit was read: nothing written");
  {
    const read = await liveStore(now);
    hook.before = async () => {
      redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(read)), String(Date.now())]);
    };
    is("not kept", await keep(read), "closed");
    is("no consent, no index, no queue member", await residue(), NONE);
  }

  part("Erased while the daily limit was read: nothing written");
  {
    const read = await liveStore(now);
    hook.before = async () => {
      await closeStoreRecord(read);
    };
    is("not kept", await keep(read), "closed");
    is("no consent, no index, no queue member", await residue(), NONE);
  }

  part("Its id key repointed to another ref (a move) while the daily limit was read: nothing written");
  {
    const read = await liveStore(now);
    is("a store with an id", /^[a-z0-9]{8,}$/i.test(read.sid), true);
    hook.before = async () => {
      redis.run(["SET", storeIdCommand(read.sid)[1], "moved-elsewhere@example.test"]);
    };
    is("not kept", await keep(read), "closed");
    is("no consent, no index, no queue member", await residue(), NONE);
  }

  part("A store from before ids: fenced on its owner's record still carrying its statsId");
  {
    const read = { ...(await liveStore(now)), sid: "" };
    is("control: its record is its own, kept", await keep(read), "kept");
    is("one consent, one index, one queue member", await residue(), { consents: 1, who: 1, queue: 1 });
  }
  {
    const live = await liveStore(now);
    const read = { ...live, sid: "" };
    hook.before = async () => {
      await closeStoreRecord(live);
    };
    is("erased while the daily limit was read: not kept", await keep(read), "closed");
    is("no consent, no index, no queue member", await residue(), NONE);
  }

  part("An answer of the fenced step that does not read: never kept, never thrown");
  for (const reply of [[2], ["1"], [0.5], [null], [], ["OK"]]) {
    const store = await liveStore(now);
    hook.reply = reply;
    let outcome: unknown;
    try {
      outcome = await keep(store);
    } catch (error) {
      outcome = `threw ${String(error)}`;
    } finally {
      hook.reply = null;
    }
    is(`${JSON.stringify(reply)}: closed`, outcome, "closed");
  }
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
