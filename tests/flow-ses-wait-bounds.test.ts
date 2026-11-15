/**
 * The bounds and the words of a workflow step waiting for room at Amazon SES (#4246; reviews of 12 November 2026 by
 * clouds F, G, B and I and Claude 1). Synthetic store, in-memory Redis, the SES stand-in.
 *
 * 1. MR (cost bound). A parked step is woken when Amazon's room is confirmed, but nothing holds that room for it:
 *    another send can take it before the woken step's try, which then meets no room and is parked again, uncounted.
 *    Job after job that loops for as long as Amazon stays near full, and a run's commands are no longer bounded by
 *    WORST_COMMANDS_PER_RUN. Now each park is counted on the run: at most SES_WAITS_PER_RUN, then the step waits as
 *    any other wait does (MAX_WAITS_PER_RUN, counted), and the run stops with a note that says why.
 * 2. Honesty. Without SES set up, or with Amazon's state never readable, nothing can ever wake a parked step, yet the
 *    run said "it goes out by itself". Now a step parks without a bound only when SES is set up and ready; otherwise it
 *    waits as before (counted, the run stops and says so), with words that never promise it goes out by itself.
 * 3. A wait for Amazon's room has its own note (SENDER_WAIT_NOTE), distinct from the company's daily room.
 * 4. A step parked again keeps the time it was first parked at this step, so the oldest email is not pushed back.
 */
import { MAX_WAITS_PER_RUN, SES_WAITS_PER_RUN } from "@/lib/flow-limits";
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { SENDER_WAIT_NOTE } from "@/lib/mail";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const RealDate = Date;
const baseNow = Date.UTC(2026, 9, 20, 9, 0, 0);
let shift = 0;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [baseNow + shift], newTarget);
  },
  get(target, key, receiver) {
    return key === "now" ? () => baseNow + shift : Reflect.get(target, key, receiver);
  },
});

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const listSent = () => mail.sesAttempts.flatMap((m) => m.to).filter((to) => to.endsWith("@example.com"));
const QUEUE = "nl:mail:flowq";
const hourKey = (back = 0) => `nl:ses:h:${new Date(Date.now() - back * 3_600_000).toISOString().slice(0, 13)}`;
/** Amazon's last 24 hours emptied: room for list email is confirmed. */
const giveRoom = async () => redisPipeline(Array.from({ length: 26 }, (_, h) => ["SET", hourKey(h), 0]));

// After a parked step is woken (ZADD QUEUE XX), another send takes Amazon's room before the step's own try.
let takeRoomOnWake = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: (string | number)[][]) => {
  const out = await pipeline(list);
  if (takeRoomOnWake && list.some((c) => c[0] === "ZADD" && c[1] === QUEUE && c[2] === "XX")) await pipeline([["SET", hourKey(), 1_000_000]]);
  return out;
}) as typeof redis.pipeline;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const scoreOf = async (email: string): Promise<number | null> => {
  const [flat] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, "-inf", "+inf", "WITHSCORES"]]);
  const list = flat as string[];
  for (let i = 0; i < list.length; i += 2) if (list[i].endsWith(`|${email}`)) return Number(list[i + 1]);
  return null;
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  delete process.env.MARKETING_DAILY_CAP;
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  await mail.setReady(true, { max24: 1_000, rate: 100 });

  const OWNER = "linnet@example.com";
  await claimHandle(OWNER, "linnetstudio", "Linnet Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLinnet0001", true);
  const renew = async () => setSubscription(OWNER, { customerId: "cus_Linnet01", subscriptionId: "sub_Linnet01", active: true, tier: "pro", period: paidPeriod() });
  await renew();
  await setMailSettings(OWNER, { fromName: "Linnet Studio", address: "1 Main St, Portland, OR 97201" });
  let store: Store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "welcome", steps: [{ id: "e000000000000001", delayHours: 0, subject: "Welcome", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const start = async (email: string) => {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag: "welcome" });
  };

  part("3. A wait for Amazon's room says so, in its own words");
  await redisPipeline([["SET", hourKey(), 1_000_000]]);
  await start("pip@example.com");
  await run();
  const pip = await readRun(flowId, personOf("pip@example.com"));
  is("the run waits", pip?.run.status, "waiting");
  is("with the note of a wait for the sending service's room", pip?.run.note, SENDER_WAIT_NOTE);
  is("not the note of the company's daily room", pip?.run.note !== "Waiting for room to send; it goes out by itself.", true);

  part("4. Parked again, a step keeps the time it was first parked");
  shift += 3_600_000;
  await start("rue@example.com");
  await run();
  const firstPip = await scoreOf("pip@example.com");
  const firstRue = await scoreOf("rue@example.com");
  is("pip was parked before rue", firstPip !== null && firstRue !== null && firstPip < firstRue, true);
  shift += 3_600_000;
  await giveRoom();
  takeRoomOnWake = true;
  await run();
  takeRoomOnWake = false;
  is("both were woken and met no room again, nothing sent", listSent().length, 0);
  const againPip = await scoreOf("pip@example.com");
  const againRue = await scoreOf("rue@example.com");
  is("pip keeps its place ahead of rue", againPip !== null && againRue !== null && againPip < againRue, true);
  is("pip's place is the one it was first given", againPip, firstPip);

  part("1. Room confirmed at the wake and taken before the try, job after job: the run's parks are bounded");
  const jobs = SES_WAITS_PER_RUN + MAX_WAITS_PER_RUN + 40;
  for (let i = 0; i < jobs; i += 1) {
    shift += 3_600_000;
    if (i % 600 === 0) await renew();
    await giveRoom();
    takeRoomOnWake = true;
    await run();
    takeRoomOnWake = false;
  }
  const looped = await readRun(flowId, personOf("pip@example.com"));
  is("the run is no longer waiting: it stopped after its bounded waits", looped?.run.status, "ended");
  is("nothing was sent", listSent().length, 0);
  is("its history says it stopped at that step", looped?.events.some((e) => e.state === "failed") ?? false, true);
  is("it is out of the queue", await scoreOf("pip@example.com"), null);

  part("2. Without SES set up, a step never parks for good and never says it goes out by itself");
  mail.disableSes();
  await start("sol@example.com");
  const solNotes: string[] = [];
  for (let i = 0; i < MAX_WAITS_PER_RUN + 10; i += 1) {
    await run();
    solNotes.push((await readRun(flowId, personOf("sol@example.com")))?.run.note ?? "");
    shift += 6 * 3_600_000;
  }
  const sol = await readRun(flowId, personOf("sol@example.com"));
  is("the run stopped after its counted waits", sol?.run.status, "ended");
  is("no note of it ever said it goes out by itself", [...solNotes, ...(sol?.events.map((e) => e.note) ?? [])].some((n) => /goes out by itself|go out by themselves/i.test(n)), false);
  is("it is out of the queue", await scoreOf("sol@example.com"), null);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => { globalThis.Date = RealDate; });
