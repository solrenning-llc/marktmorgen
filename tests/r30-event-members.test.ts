/**
 * Rules 24 and 30, synthetic only: who an event's email goes to is never decided from a read that did not come back.
 *
 * - lib/community-event-mail.ts, advanceEventJob: each batch read its members with readMembers and who is still
 *   coming with stillGoing, which answer an empty map or set for a reply lost, cut short or in another shape. The
 *   batch then counted as done (`done += keys.length`) with nobody in it emailed, and those people never were. Now
 *   a members read that is not exact leaves the batch not done, the send under way and its cursor where it was, so
 *   the next run sends to them once (the batch keys `cmev:<id>:<done>:<n>`, the `:made` marks and the email meter
 *   are unchanged). Only a member read exactly as gone (nil) or as no longer coming is left out. A send whose
 *   members never read is kept only while it is of use, as a send whose event does not read.
 * - runEventQueue, due reminders: the store came from findStore and the event from readEvent, with no exact reads.
 *   A store answering null while its address still leads to one, or an event read in another shape, dropped the
 *   reminder unsent. Now the store and the event are read as a send's are (jobTarget): only one known gone drops
 *   the reminder; anything that does not read keeps it queued while it is still due.
 */
import { createHash } from "node:crypto";
import { freshConfig, saveConfig, touchMember, type Member } from "@/lib/community";
import { KIND } from "@/lib/catalog";
import { createEvent, EVENT_QUEUE, type CommunityEvent } from "@/lib/community-events";
import { queueEventNotice, readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { claimHandle, closeStoreRecord, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const OWNER = "members-owner@example.com";
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JOBS = "nl:cm:evmailq";

/** Every pipeline goes to `hook` first; it answers, or returns undefined to let the stub answer. */
function intercept(hook: ((commands: Commands) => unknown) | null): void {
  redis.pipeline = (hook
    ? (async (commands: Commands) => {
        const reply = await hook(commands);
        return reply === undefined ? original(commands) : reply;
      })
    : original) as typeof redis.pipeline;
}

/** Who got an email whose subject is `subject`, sorted, one entry per email. */
const to = (subject: string) => mail.sent.filter((m) => m.subject === subject).flatMap((m) => m.to).sort();

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "members", "Members proof", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, freshConfig(store.name));
  const everyone = ["member000@example.com", "member001@example.com"];
  const MEMBERS = `nl:cm:${id}:m`;
  const members: Member[] = [];
  // Both asked for the community's emails (the "Email me" box), so a reminder is theirs too, and each holds its way to
  // stop already (lib/community-mail.ts tokenFor); written straight into the record.
  for (const [i, email] of everyone.entries()) members.push({ ...(await touchMember(id, email, null, store))!, mail: true, t: String(i).repeat(40) });
  for (const m of members) await original([["HSET", MEMBERS, m.k, JSON.stringify(m)]]);
  const rsvps = (e: CommunityEvent) => `nl:cm:${id}:ev:${e.id}:r`;

  /** An event three days off with both members coming, `title` its own so its emails are told apart. */
  async function event(title: string): Promise<CommunityEvent> {
    const start = Math.floor((realNow() + 3 * DAY) / HOUR) * HOUR;
    const made = await createEvent(store, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 }, realNow());
    if (!made.ok) throw new Error("no synthetic event");
    await original([["HSET", rsvps(made.event), ...members.flatMap((m, i) => [m.k, String(100 + i)])]]);
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
  /** A single HMGET of `key`, answered by `reply` from what the stub would have answered. */
  const onHmget = (key: string, reply: (real: unknown[]) => unknown) =>
    intercept(async (c) => (c.length === 1 && c[0][0] === "HMGET" && c[0][1] === key ? reply(await original(c)) : undefined));

  /** One run with `key`'s HMGET answered by `reply`, then plain runs: nobody emailed at first, each once after. */
  async function heldThenSent(title: string, key: (e: CommunityEvent) => string, reply: (real: unknown[]) => unknown, what: string): Promise<void> {
    const e = await event(title);
    const job = await moved(e);
    onHmget(key(e), reply);
    try {
      is(`${what}: the batch is not done, the send kept under way, nobody emailed`, [await run(), ...(await state(job)), await underWay(job), to(`New time: ${title}`)], ["", "sending", 0, 2, true, []]);
    } finally {
      intercept(null);
    }
    await run();
    await run();
    is(`${what}: the next run emails each of them once`, [to(`New time: ${title}`), ...(await state(job)), await underWay(job)], [everyone, "sent", 2, 2, false]);
  }

  part("Control: a send whose members read goes once to everyone coming");
  {
    const e = await event("Control night");
    const job = await moved(e);
    await run();
    await run();
    is("each got the move once", [to("New time: Control night"), ...(await state(job))], [everyone, "sent", 2, 2]);
  }

  part("A members read that does not come back exactly is not a batch of people who are gone");
  await heldThenSent("Lost members", () => MEMBERS, () => [], "the members' HMGET lost");
  await heldThenSent("Shapeless members", () => MEMBERS, () => ["QUEUED"], "the members' HMGET in another shape");
  await heldThenSent("Short members", () => MEMBERS, (real) => [(real[0] as unknown[]).slice(0, 1)], "the members' HMGET with a short reply list");
  await heldThenSent("Odd member", () => MEMBERS, (real) => [[(real[0] as unknown[])[0], 7]], "a member's row neither a record nor nil");

  part("Who is still coming, unread, is not nobody coming");
  await heldThenSent("Lost list", rsvps, () => [], "the list's HMGET lost");
  await heldThenSent("Shapeless list", rsvps, () => ["QUEUED"], "the list's HMGET in another shape");
  await heldThenSent("Short list", rsvps, (real) => [(real[0] as unknown[]).slice(0, 1)], "the list's HMGET with a short reply list");

  part("Controls: a member really gone, or no longer coming, is left out; the others get it once");
  {
    const e = await event("Gone member");
    const job = await moved(e);
    await original([["HDEL", MEMBERS, members[1].k]]);
    await run();
    await run();
    is("a member whose record is gone (nil) is skipped", [to("New time: Gone member"), ...(await state(job))], [[everyone[0]], "sent", 2, 2]);
    await original([["HSET", MEMBERS, members[1].k, JSON.stringify(members[1])]]);
  }
  {
    const e = await event("Not coming");
    const job = await moved(e);
    await original([["HDEL", rsvps(e), members[0].k]]);
    await run();
    await run();
    is("a member no longer coming is skipped", [to("New time: Not coming"), ...(await state(job))], [[everyone[1]], "sent", 2, 2]);
  }

  part("Only while it is of use: a send whose members never read before the event begins is closed, never sent late");
  {
    const e = await event("Never read");
    const job = await moved(e);
    onHmget(MEMBERS, () => []);
    Date.now = () => e.start + 60_000;
    try {
      await run();
    } finally {
      Date.now = realNow;
      intercept(null);
    }
    is("closed as failed, off the sends under way", [(await readEventJob(job))?.status, await underWay(job)], ["failed", false]);
    await run();
    is("nobody is emailed, then or after", to("New time: Never read"), []);
  }

  /** The day-before reminder of `e`, made due now; its send's id, as startJob names it. */
  async function due(e: CommunityEvent): Promise<{ entry: string; job: string }> {
    const entry = `${id}|${store.handle}|${e.id}|24|${e.start}`;
    await original([["ZADD", EVENT_QUEUE, 0, entry]]);
    return { entry, job: createHash("sha256").update(`${id}|${e.id}|24|${e.start}`).digest("hex").slice(0, 24) };
  }
  const queued = async (entry: string) => (await original([["ZSCORE", EVENT_QUEUE, entry]]))[0] !== null;
  const reminder = (title: string) => to(`Tomorrow: ${title}`);
  // A reminder goes only to members let into the community: one free product opens it, and each member's answer for it
  // is kept already (lib/community-access.ts), so nothing is asked of Stripe here.
  const TICKET = "ticketproduct";
  await saveConfig(id, { ...freshConfig(store.name), access: [TICKET] });
  for (const email of everyone) await original([["SET", `nl:cm:${id}:ok:${members[everyone.indexOf(email)].k}`, JSON.stringify({ v: 1, ok: true })]]);
  const withTicket = async (handle: string): Promise<Store | null> => {
    const found = await storeForHandle(handle);
    return found && { ...found, catalog: { ...found.catalog, items: [...found.catalog.items, { id: TICKET, kind: KIND.free } as never] } };
  };

  part("A due reminder whose store or event does not read stays queued, and goes out once when they do");
  {
    const e = await event("Store unread");
    const { entry, job } = await due(e);
    is("a store answering nothing while its address still leads to it keeps the reminder queued", [await run(async () => null), await queued(entry), await readEventJob(job)], ["", true, null]);
    await run(withTicket);
    await run(withTicket);
    is("the next run starts it, and each is reminded once", [await queued(entry), (await readEventJob(job))?.status, reminder("Store unread")], [false, "sent", everyone]);
  }
  {
    const e = await event("Event unread");
    const { entry, job } = await due(e);
    intercept((c) => (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:cm:${id}:ev:${e.id}` ? ["QUEUED"] : undefined));
    try {
      is("an event read in another shape keeps the reminder queued", [await run(withTicket), await queued(entry), await readEventJob(job)], ["", true, null]);
    } finally {
      intercept(null);
    }
    intercept((c) => (c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:cm:${id}:ev:${e.id}` ? [] : undefined));
    try {
      is("an event's reply lost keeps it too", [await run(withTicket), await queued(entry), await readEventJob(job)], ["", true, null]);
    } finally {
      intercept(null);
    }
    await run(withTicket);
    await run(withTicket);
    is("and once it reads, each is reminded once", [await queued(entry), (await readEventJob(job))?.status, reminder("Event unread")], [false, "sent", everyone]);
  }
  {
    const e = await event("Past due");
    const { entry } = await due(e);
    Date.now = () => e.start - HOUR + 60_000;
    try {
      await run(async () => null);
    } finally {
      Date.now = realNow;
    }
    is("one kept unread past its own window is let go, never sent late", [await queued(entry), reminder("Past due")], [false, []]);
  }

  part("Controls: an event or a store really gone drops the due reminder");
  {
    const e = await event("Event gone");
    const { entry, job } = await due(e);
    await original([["DEL", `nl:cm:${id}:ev:${e.id}`]]);
    await run();
    is("an event whose key answers nil: dropped, nothing started", [await queued(entry), await readEventJob(job), reminder("Event gone")], [false, null, []]);
  }
  {
    const e = await event("Store gone");
    const { entry, job } = await due(e);
    await closeStoreRecord((await storeForEmail(OWNER))!);
    is("its address leads nowhere now", await storeForHandle(store.handle), null);
    await run();
    is("a store closed: dropped, nothing started", [await queued(entry), await readEventJob(job), reminder("Store gone")], [false, null, []]);
  }

  done();
}

void main();
