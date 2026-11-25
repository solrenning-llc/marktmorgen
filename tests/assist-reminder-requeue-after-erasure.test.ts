/**
 * A checkout still open when its reminder comes due is put back in the queue only while its store is live (#5010 row
 * 86, Codex L-20261119-1255, HIGH). remindFromConsent reads the buyer's yes (nl:assist:remind:<checkout>), then reads
 * the checkout on the creator's Stripe account; while that read is in flight the store's erasure can begin or end, or
 * the person's own erasure can delete the yes. On main it then wrote the yes back (SET, with the buyer's address) and a
 * new queue member (ZADD) as two plain commands, so both came back under a store that no longer exists. Now they are
 * one step fenced on the store being live (lib/live-fence.ts's rule: its erasing mark absent and its id key still
 * holding this very store's ref), and the yes is rewritten only while it is still there (SET XX).
 *
 * What is checked, synthetic data only (Stripe is a stand-in; the sender and the model are never reached):
 *   - control: a live store's open checkout gets its yes marked as put back (r: 1) and one new queue member;
 *   - erased during the Stripe read (closeStoreRecord, then the walk deleting the yes and its queue member): "skip",
 *     and no yes, no queue member;
 *   - its erasing mark set during the read: "skip", the yes not rewritten and no new queue member;
 *   - its id key repointed to another ref (an account move) during the read: the same;
 *   - the person's own erasure (forgetAssistReminderPerson) during the read: "skip", the yes not recreated;
 *   - a store from before ids: fenced on its owner's record still carrying its statsId (control and erased);
 *   - an answer of the fenced step that does not read (rule 24): thrown, never "open" counted as written;
 *   - the open route's commands, measured, stay inside ASSIST_REMIND_COMMANDS, the reminder's review ceiling.
 */
import { claimHandle, closeStoreRecord, ensureListId, ensureStatsId, ERASING_KEY, erasingField, setAssistReminder, setAssistantPlan, setRecovery, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { ASSIST_REMIND_AFTER_SECONDS, ASSIST_REMIND_COMMANDS, ASSIST_REMIND_VERSION, assistRemindKey } from "@/lib/assistant-reminder-rules";
import { REQUEUE_IF_STORE_LIVE_COMMANDS, forgetAssistReminderPerson, keepAssistReminder, remindFromConsent } from "@/lib/assistant-reminder";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_assist_reminder_requeue_only";
process.env.RESEND_API_KEY = "re_test_assist_reminder_requeue_only";

const OWNER = "remind-requeue@example.test";
const ACCOUNT = "acct_fixture004";
const ADDRESS = "12 Oven Lane, Portland, OR 97201";
const QUEUE = "nl:assist:remindq";
type Command = (string | number)[];

/** Checkouts as Stripe has them, by id. */
const sessions: Record<string, Record<string, unknown>> = {};
/** Something to run while Stripe is being read (an erasure landing in that wait). */
const during: { read: (() => Promise<void>) | null } = { read: null };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const one = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && one && method === "GET") {
    const run = during.read;
    if (run) {
      during.read = null;
      await run();
    }
    return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  throw new Error(`no network in this test: ${method} ${String(input)}`);
}) as typeof fetch;

/** A reply to put in place of the fenced step, and every command the route sends, counted as it is billed. */
const hook: { reply: unknown[] | null; billed: number | null } = { reply: null, billed: null };
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = async (batch: Command[]) => {
  if (hook.billed !== null) {
    for (const command of batch) {
      // An EVAL is billed as itself and every call it makes; each script here has no loop, so its calls are at most
      // the redis.call()s it is written with.
      hook.billed += command[0] === "EVAL" ? 1 + [...String(command[1]).matchAll(/redis\.call\(/g)].length : 1;
    }
  }
  if (hook.reply && batch.length === 1 && batch[0][0] === "EVAL" && String(batch[0][1]).includes("reminder-requeue-live")) return hook.reply;
  return pipeline(batch);
};

let n = 0;
const sessionId = () => `cs_test_assistrequeue${String((n += 1)).padStart(6, "0")}`;

async function liveStore(now: number): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "ovenrequeue", "Oven Requeue", "Recipes for busy weeknights.");
  await setSubscription(OWNER, { customerId: "cus_OvenRequeue1", subscriptionId: "sub_OvenRequeue", active: true, tier: "creator", trialEnds: 0, period: paidPeriod(now) });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setAssistReminder(OWNER, { on: true });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_AssistRequeue", active: true, period: paidPeriod(now), cancelsAtEnd: false, disputedAt: "" });
  await setRecovery(OWNER, { enabled: false, address: ADDRESS, asks: true });
  return (await storeForEmail(OWNER))!;
}

/** The buyer's yes for one checkout, kept as the checkout route keeps it, and the checkout as Stripe has it: still open. */
async function openCheckout(store: Store, now: number, later: number): Promise<string> {
  const session = sessionId();
  const kept = await keepAssistReminder({ store, session, email: "fay@example.com", version: ASSIST_REMIND_VERSION, now });
  if (kept !== "kept") throw new Error(`the yes was not kept: ${kept}`);
  sessions[session] = { id: session, object: "checkout.session", status: "open", payment_status: "unpaid", created: Math.floor(now / 1000), expires_at: Math.floor(later / 1000) + 600, consent: null, customer_details: null, metadata: { store: store.handle } };
  return session;
}

/** The yes as kept (null when gone) and how many queue members name this checkout. */
function residue(session: string): { yes: Record<string, unknown> | null; members: number } {
  const raw = redis.run(["GET", assistRemindKey(session)]);
  const queue = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  return { yes: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : null, members: queue.filter((m) => m.includes(session)).length };
}

/** Each queue member naming this checkout, with its score. */
function queued(session: string): [string, unknown][] {
  const queue = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  return queue.filter((m) => m.includes(session)).sort().map((m) => [m, redis.run(["ZSCORE", QUEUE, m])]);
}

/**
 * The checkout's queue entry made the very member a requeue of this open checkout would write (its due inside it,
 * lib/assistant-reminder.ts remindFromConsent), at score 1, a time no requeue writes, and read back. A requeue's ZADD
 * would then re-add the same member: the count of members stays 1, and only its score shows the ZADD (Claude 6
 * jAAv7's NIT and Claude 5 ichw's LEVE on #5372).
 */
function sameMemberQueued(store: Store, session: string): [string, unknown][] {
  for (const [member] of queued(session)) redis.run(["ZREM", QUEUE, member]);
  const due = Number(sessions[session].expires_at) + ASSIST_REMIND_AFTER_SECONDS;
  redis.run(["ZADD", QUEUE, 1, JSON.stringify([store.statsId, store.handle, session, due])]);
  return queued(session);
}

/** What the store's closing walk does to a reminder after closeStoreRecord: its yes and its queue member go. */
function walkDeletes(session: string): void {
  redis.run(["DEL", assistRemindKey(session)]);
  for (const member of redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]) if (member.includes(session)) redis.run(["ZREM", QUEUE, member]);
}

async function main(): Promise<void> {
  const now = Date.now();
  /** When the first reminder is due: an hour for the checkout to close, an hour more. */
  const later = now + 2 * 3_600_000 + 60_000;

  part("Control: a live store's open checkout is put back once, its yes marked");
  {
    const store = await liveStore(now);
    const session = await openCheckout(store, now, later);
    is("one queue member before", residue(session).members, 1);
    hook.billed = 0;
    const outcome = await remindFromConsent(store, session, later);
    const billed = hook.billed;
    hook.billed = null;
    is("still open: not yet", outcome, "open");
    const after = residue(session);
    is("the yes kept, marked as put back, with the address", [after.yes?.r, after.yes?.e], [1, "fay@example.com"]);
    is("a second queue member, for an hour after it closes", after.members, 2);
    is(`the open route's commands, measured (${billed}), stay inside the reminder's ceiling of ${ASSIST_REMIND_COMMANDS}`, billed > 0 && billed <= ASSIST_REMIND_COMMANDS, true);
    is("the fenced step is billed as five: the EVAL and its HGET, GET, SET, ZADD", REQUEUE_IF_STORE_LIVE_COMMANDS, 5);
    console.log(`the open route: ${billed} commands billed, of ${ASSIST_REMIND_COMMANDS} (the requeue itself ${REQUEUE_IF_STORE_LIVE_COMMANDS}, two plain before)`);
  }

  part("Erased while Stripe was read: nothing comes back");
  {
    const store = await liveStore(now);
    const session = await openCheckout(store, now, later);
    during.read = async () => {
      await closeStoreRecord(store);
      walkDeletes(session);
    };
    is("skip", await remindFromConsent(store, session, later), "skip");
    is("no yes, no queue member", residue(session), { yes: null, members: 0 });
  }

  part("Its erasure began while Stripe was read: nothing written");
  {
    const store = await liveStore(now);
    const session = await openCheckout(store, now, later);
    during.read = async () => {
      redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
    };
    is("skip", await remindFromConsent(store, session, later), "skip");
    const after = residue(session);
    is("the yes not rewritten, and no new queue member", [after.yes?.r, after.members], [undefined, 1]);
  }

  part("Its id key repointed to another ref (a move) while Stripe was read: nothing written");
  {
    const store = await liveStore(now);
    is("a store with an id", /^[a-z0-9]{8,}$/i.test(store.sid), true);
    const session = await openCheckout(store, now, later);
    during.read = async () => {
      redis.run(["SET", storeIdCommand(store.sid)[1], "moved-elsewhere@example.test"]);
    };
    const before = sameMemberQueued(store, session);
    is("skip", await remindFromConsent(store, session, later), "skip");
    const after = residue(session);
    is("the yes not rewritten, and no new queue member", [after.yes?.r, after.members], [undefined, 1]);
    is("and the member that was there is not added again: its score is unchanged (no ZADD)", queued(session), before);
  }

  part("The person erased while Stripe was read: the yes is not recreated, and no new queue member is added");
  {
    const store = await liveStore(now);
    const session = await openCheckout(store, now, later);
    // Only the person's own erasure here, no store closing (Claude 5 ib47's LOW on #5372): it deletes the yes, and
    // the queue member already there stays, holding no address; the job skips it, since the yes is gone.
    during.read = async () => {
      await forgetAssistReminderPerson(store.statsId!, "fay@example.com");
    };
    const before = sameMemberQueued(store, session);
    is("skip", await remindFromConsent(store, session, later), "skip");
    is("no yes, and only the member that was there", residue(session), { yes: null, members: 1 });
    is("and it is not added again: its score is unchanged (SET ... XX wrote nothing, so no ZADD)", queued(session), before);
  }

  part("A store from before ids: fenced on its owner's record still carrying its statsId");
  {
    const live = await liveStore(now);
    const read = { ...live, sid: "" };
    const session = await openCheckout(read, now, later);
    is("control: its record is its own, put back", await remindFromConsent(read, session, later), "open");
    is("marked, and a second queue member", [residue(session).yes?.r, residue(session).members], [1, 2]);
  }
  {
    const live = await liveStore(now);
    const read = { ...live, sid: "" };
    const session = await openCheckout(read, now, later);
    during.read = async () => {
      await closeStoreRecord(live);
      walkDeletes(session);
    };
    is("erased while Stripe was read: skip", await remindFromConsent(read, session, later), "skip");
    is("no yes, no queue member", residue(session), { yes: null, members: 0 });
  }

  part("An answer of the fenced step that does not read: unknown, thrown for the job to try again");
  for (const reply of [[2], ["1"], [-1], [null], [], ["OK"]]) {
    const store = await liveStore(now);
    const session = await openCheckout(store, now, later);
    hook.reply = reply;
    let outcome: unknown;
    try {
      outcome = await remindFromConsent(store, session, later);
    } catch (error) {
      outcome = error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`;
    } finally {
      hook.reply = null;
    }
    is(`${JSON.stringify(reply)}: unknown`, outcome, "unknown");
  }
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
