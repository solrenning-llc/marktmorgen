/**
 * Each email to somebody brought over costs, beside what it did before, exactly MOVED_EMAIL_EXTRA_COMMANDS Redis
 * commands, the figure the imports cost line prices on every one (tests/plan-cost-registry.ts; review of #3476, cost
 * MEDIUM 1). Counted on the real send paths, a member's first email (runImport) and their reminder
 * (sendMoveReminders), every command recorded: the store's deleted people read (one HMGET: suppressedAmong), the
 * creator's list's rows (one HMGET: leftListAmong), the stop mark (one EXISTS: remindersStoppedAmong), and the stop
 * link written with its three erasure notes (lib/checkout-recovery.ts moveStopLink, lib/erasure-index.ts
 * noteForErasure). Synthetic only: Stripe and the sender are stand-ins for fetch, Redis is lib/redis-memory.ts.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MOVED_EMAIL_EXTRA_COMMANDS, addRows, finishUpload, runImport, sendMoveReminders, startImport } from "@/lib/imports";
import { INVITE_UNLESS_ERASED } from "@/lib/move-members";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const POSTAL = "12 Harbor Lane, Portland, ME 04101, USA";
type Sent = { to: string | string[]; text: string };
const emails: Sent[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com" && url.pathname.startsWith("/emails")) {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** The commands an email to somebody brought over adds, by what they read or write. */
const GUARDS: [string, (c: (string | number)[]) => boolean][] = [
  ["the store's deleted people", (c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:")],
  ["the list's rows", (c) => c[0] === "HMGET" && String(c[1]).startsWith("nl:store:leads:")],
  ["the stop mark", (c) => c[0] === "EXISTS" && String(c[1]).startsWith("nl:recover:off:")],
  ["the stop link's erasure notes", (c) => String(c[1]).startsWith("nl:erase:ix:")],
  ["the stop link", (c) => c[0] === "SET" && String(c[1]).startsWith("nl:recover:link:")],
];
const original = redis.pipeline.bind(redis);
async function recorded<T>(run: () => Promise<T>): Promise<{ result: T; commands: (string | number)[][] }> {
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch: (string | number)[][]) => {
    commands.push(...batch);
    return original(batch);
  };
  try {
    return { result: await run(), commands };
  } finally {
    redis.pipeline = original;
  }
}
const guardsIn = (commands: (string | number)[][]) => Object.fromEntries(GUARDS.map(([name, test]) => [name, commands.filter(test).length]));
const total = (counts: Record<string, number>) => Object.values(counts).reduce((s, n) => s + n, 0);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_move_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_move_only_a_stand_in";
  redis.clear();
  const OWNER = "count-owner@example.com";
  await claimHandle(OWNER, "countshop", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: POSTAL });
  await setStripeAccount(OWNER, "acct_1TestMovedCount01", true);
  await setSubscription(OWNER, { customerId: "cus_MovedCount1", subscriptionId: "sub_MovedCount1", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;
  const member = "fern@example.com";
  const in20 = Math.floor(Date.now() / 1000) + 20 * DAY;

  part("A member's first email: the commands it adds are what MOVED_EMAIL_EXTRA_COMMANDS prices");
  const m = await startImport(store, OWNER, "members", { expected: 1, file: "patrons.csv", stopped: true });
  if (!m.ok) throw new Error(`members not started: ${m.reason}`);
  await addRows(store, m.job.id, [["2", member, "The Inner Circle", new Date(in20 * 1000).toISOString().slice(0, 10), ""]]);
  await finishUpload(store, m.job.id);
  // Every pass recorded; the one that emails the member is counted.
  let job: Awaited<ReturnType<typeof runImport>> | undefined;
  let mailing = { "no pass emailed": 0 } as Record<string, number>;
  let chunks = -1;
  for (let i = 0; i < 10 && job?.state !== "done"; i += 1) {
    const before = emails.length;
    const pass = await recorded(() => runImport(m.job.id, Date.now() + 30_000));
    job = pass.result;
    if (emails.length > before) {
      mailing = guardsIn(pass.commands);
      chunks = pass.commands.filter((c) => c[0] === "EVAL" && c[1] === INVITE_UNLESS_ERASED).length;
    }
  }
  // The same pass may write the member's chunk, whose own deleted-people read (one HMGET before the repeat check, and
  // the script) is priced a chunk, not an email (the cost line's basis): it is taken out here.
  if (chunks > 0) mailing["the store's deleted people"] -= chunks;
  is("control: the member is emailed once, with a stop link", [job?.state, emails.filter((e) => [e.to].flat()[0] === member).length], ["done", 1]);
  is("control: that pass also wrote the member's chunk (one script), its read priced a chunk", chunks, 1);
  is("each guard once", mailing, { "the store's deleted people": 1, "the list's rows": 1, "the stop mark": 1, "the stop link's erasure notes": 3, "the stop link": 1 });
  is("as many as the cost line prices an email", total(mailing), MOVED_EMAIL_EXTRA_COMMANDS);

  part("The member's reminder: the same commands, the same figure");
  const before = emails.length;
  const reminder = await recorded(() => sendMoveReminders(Date.now() + 30_000, (in20 - 2 * DAY + 3_600) * 1000));
  is("control: the reminder goes, once", [reminder.result.sent, emails.length - before], [1, 1]);
  const reminded = guardsIn(reminder.commands);
  is("each guard once", reminded, { "the store's deleted people": 1, "the list's rows": 1, "the stop mark": 1, "the stop link's erasure notes": 3, "the stop link": 1 });
  is("as many as the cost line prices an email", total(reminded), MOVED_EMAIL_EXTRA_COMMANDS);
  done();
}

void main();
