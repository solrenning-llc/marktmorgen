/**
 * Rules 24 and 30, synthetic only: an event's send under way (a reminder, or the email telling everyone coming that
 * an event moved or was called off) is never closed unsent because its store or its event did not read at that
 * moment, and one send that fails on the way never stops the others.
 *
 * - lib/community-event-mail.ts, advanceEventJob: the store was loaded with `load(handle).catch(() => null)`, and the
 *   community's setup and the event with readConfig and readEvent, which answer null for a lost reply too. A store
 *   that did not load, or an event that did not read, was taken for gone: the send was closed, "failed: The event is
 *   not there anymore.", and everyone not yet emailed never was. Now only a store, a setup or an event known to be
 *   gone (its key read whole, and empty or let go) closes the send; one that does not read leaves it as it is, to be
 *   moved on by a later run, while it is still of use (a reminder by its own window, a notice until the event
 *   begins), and the rest goes out once, never twice (the batch keys and the email meter are unchanged).
 * - runEventQueue: a send that threw on the way (an event that did not read) took the whole round down, and the
 *   sends after it in the round were not moved on. Now each is moved on in its own try.
 */
import { freshConfig, saveConfig, touchMember, type Member } from "@/lib/community";
import { createEvent, type CommunityEvent } from "@/lib/community-events";
import { advanceEventJob, queueEventNotice, readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { claimHandle, closeStoreRecord, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const OWNER = "job-load-owner@example.com";
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JOBS = "nl:cm:evmailq";

/** Every pipeline goes to `hook` first; it answers, throws, or returns undefined to let the stub answer. */
function intercept(hook: ((commands: Commands) => unknown) | null): void {
  redis.pipeline = (hook
    ? (async (commands: Commands) => {
        const reply = await hook(commands);
        return reply === undefined ? original(commands) : reply;
      })
    : original) as typeof redis.pipeline;
}

const fail = (): never => {
  throw new Error("synthetic pipeline failure");
};

/** Who got an email whose subject is `subject`, sorted, one entry per email. */
const to = (subject: string) => mail.sent.filter((m) => m.subject === subject).flatMap((m) => m.to).sort();

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "jobload", "Job load proof", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  // 101 members: one more than a notice's batch (BATCH_SIZE, lib/mail.ts), so a send can stop half way.
  const everyone = Array.from({ length: 101 }, (_, i) => `member${String(i).padStart(3, "0")}@example.com`);
  const members: Member[] = [];
  for (const email of everyone) members.push((await touchMember(id, email, null, store))!);
  const two = everyone.slice(0, 2);

  /** An event three days off with the first `count` members coming, `title` its own so its emails are told apart. */
  async function event(title: string, count: number): Promise<CommunityEvent> {
    const start = Math.floor((realNow() + 3 * DAY) / HOUR) * HOUR;
    const made = await createEvent(store, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 }, realNow());
    if (!made.ok) throw new Error("no synthetic event");
    const fields = members.slice(0, count).flatMap((m, i) => [m.k, String(100 + i)]);
    await original([["HSET", `nl:cm:${id}:ev:${made.event.id}:r`, ...fields]]);
    return made.event;
  }
  /** The move's notice for `e`, written down with its readers (nothing sent yet). */
  async function moved(e: CommunityEvent): Promise<string> {
    const job = await queueEventNotice(store, { ...e, moves: 1 }, "moved", { start: e.start - DAY, minutes: 60 });
    if (!job) throw new Error("no synthetic send");
    return job.id;
  }
  /** One run of the five-minute job's event part; what it threw, or "" when it did not. */
  async function run(findStore: (handle: string) => Promise<Store | null> = storeForHandle): Promise<string> {
    try {
      await runEventQueue(findStore, Date.now() + 20_000, { mail: true });
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  }
  const state = async (job: string) => {
    const read = await readEventJob(job);
    return [read?.status, read?.done, read?.total];
  };
  const underWay = async (job: string) => ((await original([["SISMEMBER", JOBS, job]]))[0] as number) === 1;

  part("Control: a send whose store loads goes once to everyone coming");
  {
    const e = await event("Control night", 2);
    await moved(e);
    await run();
    await run();
    is("each got the move once", to("New time: Control night"), two);
  }

  part("A store that does not load half way through a send: the send is kept, and the rest goes out once");
  {
    const e = await event("Big night", 101);
    const job = await moved(e);
    // The first run stops after one batch: the clock passes its deadline once a hundred are sent.
    const sentBefore = mail.sent.length;
    const deadline = realNow() + 20_000;
    Date.now = () => (mail.sent.length >= sentBefore + 100 ? deadline + 1 : realNow());
    try {
      await advanceEventJob(job, storeForHandle, deadline);
    } finally {
      Date.now = realNow;
    }
    is("half way: a hundred of the 101 emailed, the send still under way", [to("New time: Big night").length, ...(await state(job))], [100, "sending", 100, 101]);
    is("a run whose store throws on loading does not throw", await run(async () => fail()), "");
    is("and leaves the send as it was, still under way", [...(await state(job)), await underWay(job)], ["sending", 100, 101, true]);
    is("a run whose store answers nothing while its address still leads to it leaves it too", [await run(async () => null), ...(await state(job))], ["", "sending", 100, 101]);
    await run();
    is("the next run with the store loaded sends the last one", [...(await state(job)), await underWay(job)], ["sent", 101, 101, false]);
    await run();
    const got = to("New time: Big night");
    is("each of the 101 got it once, never twice", [got.length, new Set(got).size, got.join() === everyone.join()], [101, 101, true]);
  }

  part("A setup or an event that does not read is not a setup or an event that is gone");
  {
    const e = await event("Unread setup", 2);
    const job = await moved(e);
    intercept((c) => (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:cm:${id}:cfg` ? ["QUEUED"] : undefined));
    try {
      is("a setup read in another shape leaves the send under way", [await run(), ...(await state(job))], ["", "sending", 0, 2]);
    } finally {
      intercept(null);
    }
    intercept((c) => (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:cm:${id}:ev:${e.id}` ? ["QUEUED"] : undefined));
    try {
      is("an event read in another shape leaves it too", [await run(), ...(await state(job))], ["", "sending", 0, 2]);
    } finally {
      intercept(null);
    }
    await run();
    is("and once they read, each is emailed once", [to("New time: Unread setup"), ...(await state(job))], [two, "sent", 2, 2]);
  }

  part("One send whose event throws on reading does not stop the others in the same run");
  {
    const first = await event("Throwing night", 2);
    const second = await event("Next night", 2);
    const a = await moved(first);
    const b = await moved(second);
    intercept((c) => {
      // The sends under way, the throwing one first, so the other comes after it in the round.
      if (c.length === 1 && c[0][0] === "SMEMBERS" && c[0][1] === JOBS) return [[a, b]];
      if (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:cm:${id}:ev:${first.id}`) return fail();
      return undefined;
    });
    let thrown = "";
    try {
      thrown = await run();
    } finally {
      intercept(null);
    }
    is("the run does not throw", thrown, "");
    is("the other send is moved on, each emailed once", [to("New time: Next night"), ...(await state(b))], [two, "sent", 2, 2]);
    is("the throwing one is left under way, nobody emailed", [to("New time: Throwing night"), ...(await state(a)), await underWay(a)], [[], "sending", 0, 2, true]);
    await run();
    await run();
    is("and the next run emails each of its people once", [to("New time: Throwing night"), ...(await state(a))], [two, "sent", 2, 2]);
  }
  {
    const first = await event("Members unread", 2);
    const second = await event("After it", 2);
    const a = await moved(first);
    const b = await moved(second);
    let once = true;
    intercept((c) => {
      if (c.length === 1 && c[0][0] === "SMEMBERS" && c[0][1] === JOBS) return [[a, b]];
      // The first send's members do not read (the call throws, past the event's own reads).
      if (once && c.length === 1 && c[0][0] === "HMGET" && c[0][1] === `nl:cm:${id}:m`) {
        once = false;
        return fail();
      }
      return undefined;
    });
    let thrown = "";
    try {
      thrown = await run();
    } finally {
      intercept(null);
    }
    is("a send that throws while sending does not throw the run", thrown, "");
    is("the send after it is moved on, each emailed once", [to("New time: After it"), ...(await state(b))], [two, "sent", 2, 2]);
    is("the one that threw is left under way, its lock given back", [to("New time: Members unread"), ...(await state(a)), await underWay(a)], [[], "sending", 0, 2, true]);
    await run();
    await run();
    is("and the next run emails each of its people once", [to("New time: Members unread"), ...(await state(a))], [two, "sent", 2, 2]);
  }

  part("Only while it is of use: a send whose store never loads before the event begins is closed, never sent late");
  {
    const e = await event("Late night", 2);
    const job = await moved(e);
    Date.now = () => e.start + 60_000;
    try {
      await run(async () => fail());
    } finally {
      Date.now = realNow;
    }
    is("closed as failed and off the sends under way", [(await readEventJob(job))?.status, await underWay(job)], ["failed", false]);
    await run();
    is("nobody is emailed, then or after", to("New time: Late night"), []);
  }

  part("Control: a store really gone (closed, its address let go) still closes the send");
  {
    const e = await event("Gone night", 2);
    const job = await moved(e);
    await closeStoreRecord((await storeForEmail(OWNER))!);
    is("its address leads nowhere now", await storeForHandle(store.handle), null);
    await run();
    const closed = await readEventJob(job);
    is("the send is closed as failed, nobody emailed", [closed?.status, closed?.note, await underWay(job), to("New time: Gone night")], ["failed", "The event is not there anymore.", false, []]);
  }

  done();
}

void main();
