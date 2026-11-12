/**
 * C3-106 (owner): once a free trial is over, no path a store's closing is
 * priced for uses the trial's own figures (tests/store-data-registry.ts,
 * AFTER_TRIAL_UNITS). Each path is run through its real code, with the store
 * as lib/plan-standing.ts (standingOf) stands it: "ended" (its trial's
 * subscription stopped) and "none" (never subscribed). Webhooks (emitEvent,
 * and a try of a delivery made during the trial), the studio (countStudio),
 * the API (takeMoreApi, holdMoreApi), the list's emails (reserve,
 * takeFromMonth) and a store's own and access emails (sendEmail): each takes
 * up to its standing's figure and refuses the next one, where the trial's
 * figure would let it through. A subscription started again before the
 * closing day is priced as the paid plan it is, at the plan's figures.
 * Synthetic stores, keys and senders only; nothing leaves this machine.
 */
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { sendEmail } from "@/lib/email";
import { monthlyAllowance, reserve, takeFromMonth } from "@/lib/mail";
import { monthlyEmails } from "@/lib/plan";
import { standingOf } from "@/lib/plan-standing";
import { NON_PAYING_ALLOWANCES, STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { countStudio } from "@/lib/studio-route";
import { addEndpoint, deliverDue, emitEvent, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { AFTER_TRIAL_UNITS, TRIAL_UNITS } from "./store-data-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_after_trial_units_only";
let sent = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    sent += 1;
    return Response.json({ id: `email_${sent}` });
  }
  throw new Error(`unexpected synthetic call ${url}`);
}) as typeof fetch;
// Every webhook try is refused before a socket opens.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const logged = console.error;
console.error = (...args: unknown[]) => (/^(a webhook delivery failed|an email was not sent)/.test(String(args[0])) ? undefined : logged(...args));
// The webhook queue's lease (lib/webhooks.ts, LEASE_SCRIPT), as Redis runs it and tests/webhooks-delivery.test.ts models it;
// refused while `leaseOff`, so a delivery made then waits untried, as when the try after it never ran.
let leaseOff = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  const [only] = batch;
  if (batch.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    if (leaseOff) return [0];
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await pipeline([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await pipeline([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return pipeline(batch);
}) as typeof redis.pipeline;

const HOUR = 3_600;
let n = 0;
async function store(kind: "trial" | "none"): Promise<{ owner: string; read: () => Promise<Store> }> {
  n += 1;
  const owner = `after-trial-${n}@example.com`;
  await claimHandle(owner, `after-trial-${n}`, `After Trial ${n}`, "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  if (kind === "trial") {
    await setSubscription(owner, { customerId: `cus_AfterTrial${n}0000`, subscriptionId: `sub_AfterTrial${n}0000`, active: true, tier: "pro", cycle: "month", trialEnds: Math.floor(Date.now() / 1000) + 7 * 24 * HOUR, period: null });
  }
  return { owner, read: async () => (await storeForEmail(owner))! };
}
const email = (s: Store, kind: "email" | "transactional", i: number) =>
  sendEmail({ from: "After Trial <store@marktmorgen.com>", to: `buyer${i}@example.com`, subject: "Synthetic", text: "Synthetic", meter: { by: "store", store: s, kind } } as Parameters<typeof sendEmail>[0]);
async function webhookBody(s: Store, id: string): Promise<string> {
  const [raw] = await redis.pipeline([["GET", `nl:hooks:d:${id}`]]);
  return (JSON.parse(String(raw)) as { body: string }).body;
}
const newestDelivery = async (s: Store) => String(((await redis.pipeline([["LRANGE", `nl:hooks:log:${s.statsId}`, 0, 0]]))[0] as string[])[0]);

/** Every path at the store's standing: up to its figure, never past it, where a trial's figure would go further. */
async function afterTrial(label: string, s: Store, standing: "ended" | "none"): Promise<void> {
  const figures = NON_PAYING_ALLOWANCES[standing];
  is(`${label}: standingOf says ${standing}`, standingOf(s), standing);

  // Webhooks: a message made now is not kept or sent (its month has no deliveries), so no body is kept after the trial.
  is(`${label}: webhooks, a figure of ${figures.webhook}, under the trial's ${TRIAL_UNITS.webhook}`, [figures.webhook, figures.webhook <= AFTER_TRIAL_UNITS.webhook, figures.webhook < TRIAL_UNITS.webhook], [0, true, true]);
  is(`${label}: a message made after the trial is not queued`, await emitEvent(s, "sale.completed", `after-${label}`, { amount_cents: 100 }), 0);
  is(`${label}: and no message is kept for it`, await webhookBody(s, await newestDelivery(s)), "");

  // The studio: its figure taken whole, then the next refused.
  is(`${label}: the studio's figure ${figures.studio}, under the trial's ${NON_PAYING_ALLOWANCES.trial.studio}`, [(await countStudio(s, null, figures.studio)).ok, (await countStudio(s, null, 1)).ok], [true, false]);

  // The API: none past the door's, where a trial has a hundred.
  const take = await takeMoreApi(s, 1);
  const hold = await holdMoreApi(s, 1);
  is(`${label}: the API refuses one more request (the trial's ${NON_PAYING_ALLOWANCES.trial.api} would take it)`, [take?.status, hold instanceof Response ? hold.status : "held"], [429, 429]);

  // The list's emails: a store not on a running plan has none to send, where a trial has its own.
  is(`${label}: the list's emails, none (no trial figure)`, [monthlyAllowance(s), await reserve(s, 1), await takeFromMonth(s, 1)], [0, "month", 0]);

  // A store's own emails and its buyers' access emails: up to the standing's figure, then refused, nothing sent.
  for (const kind of ["email", "transactional"] as const) {
    const before = sent;
    let ok = 0;
    for (let i = 0; i < NON_PAYING_ALLOWANCES.trial[kind] + 1; i += 1) if (await email(s, kind, i)) ok += 1;
    is(`${label}: ${kind} emails stop at the standing's ${figures[kind]}, not the trial's ${NON_PAYING_ALLOWANCES.trial[kind]}`, [ok, sent - before], [figures[kind], figures[kind]]);
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("A delivery made during the trial and never tried, tried after it: not sent, and its message not kept");
  const trial = await store("trial");
  is("a trial's store", standingOf(await trial.read()), "trial");
  is("its endpoint is kept", (await addEndpoint(await trial.read(), "https://hooks.example.net/in", ["sale.completed"])).ok, true);
  leaseOff = true;
  is("a message made during the trial is queued", await emitEvent(await trial.read(), "sale.completed", "during-trial", { amount_cents: 100 }), 1);
  leaseOff = false;
  const waiting = await newestDelivery(await trial.read());
  is("and its message kept, to be tried", (await webhookBody(await trial.read(), waiting)).length > 0, true);
  await setSubscription(trial.owner, { active: false, period: null });
  await deliverDue(Date.now() + 10_000, Date.now() + 60_000);
  is("tried after the trial: its message is not kept", await webhookBody(await trial.read(), waiting), "");

  part('After the trial, the store as "ended": every path at an ended store\'s figures');
  await afterTrial("ended", await trial.read(), "ended");

  part('A store that never subscribed, "none": every path at its figures');
  const none = await store("none");
  is("its endpoint is kept", (await addEndpoint(await none.read(), "https://hooks.example.net/in", ["sale.completed"])).ok, true);
  await afterTrial("none", await none.read(), "none");

  part("A subscription started again before the closing day: the paid plan's figures, not the trial's or an ended store's");
  await setSubscription(trial.owner, { active: true, tier: "pro", cycle: "month", trialEnds: 0, period: paidPeriod() });
  const back = await trial.read();
  is("standingOf says paid", standingOf(back), "paid");
  is("the API takes past the trial's figure", await takeMoreApi(back, NON_PAYING_ALLOWANCES.trial.api + 1), null);
  is("the studio takes past the trial's figure", (await countStudio(back, null, NON_PAYING_ALLOWANCES.trial.studio + 1)).ok, true);
  is("the list's emails are the plan's", monthlyAllowance(back), monthlyEmails("pro"));
  is("a message made now is queued and kept", await emitEvent(back, "sale.completed", "after-reactivation", { amount_cents: 100 }), 1);
  is("with its message", (await webhookBody(back, await newestDelivery(back))).length > 0, true);
  is("the plan's webhook figure is past the trial's", STORE_ALLOWANCES.pro.webhook > NON_PAYING_ALLOWANCES.trial.webhook, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
