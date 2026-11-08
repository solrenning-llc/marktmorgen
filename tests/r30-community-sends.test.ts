/**
 * Rules 24 and 30, synthetic only: who a community's email goes to is never decided from an answer that did not come
 * back, and nobody is left out of a batch that then counts as done.
 *
 * - lib/community-mail.ts, advanceAnnouncement: each batch read its members with readMembers, which answers an empty
 *   map for a reply lost, cut short or in another shape, and asked holdsTicket, which answers "no" when Stripe could
 *   not be asked. The batch then counted as done (`done += keys.length`) with those people never emailed. Now the
 *   members are read exactly (readMembersExact) and the ticket strictly: an answer that does not come back leaves the
 *   batch, its cursor and the send queued, and the next run sends to them once under the same batch key. Only a member
 *   read exactly as gone (nil), taken out, no longer asking for the emails, or let in no more is left out.
 * - lib/community-event-mail.ts, the reminders' batches: holdsTicket and mayAttend answered "no" on a Stripe that could
 *   not be asked, dropping the member from a batch counted as done. Now they are asked strictly, as above.
 * - tokenFor, in both: a member's stop-link token was written with setMemberToken, which kept nothing when the
 *   member's record did not read, and the email went out with a stop link that leads nowhere. Now the token is the one
 *   the record keeps, or the batch waits; a token another send made first is the one used.
 */
import { createHash } from "node:crypto";
import { freshConfig, saveConfig, touchMember, type Member, type Post } from "@/lib/community";
import { KIND } from "@/lib/catalog";
import { createEvent, EVENT_QUEUE, type CommunityEvent } from "@/lib/community-events";
import { advanceAnnouncement, queueAnnouncement, readCommunityUnsub, readJob } from "@/lib/community-mail";
import { readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setMailSettings, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const OWNER = "sends-owner@example.com";
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);
// Installed below, before anything is written: every pipeline goes through stub().
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAILQ = "nl:cm:mailq";
const JOBS = "nl:cm:evmailq";
const TICKET = "ticketproduct";

/**
 * The stub, with lib/community.ts CAS_MEMBER (a member's record written only over the one it was read as) done here,
 * since the stub has no EVAL for it: a stop-link token is kept on a member's record through it.
 */
async function stub(commands: Commands): Promise<unknown[]> {
  const cas = commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET", KEYS[1], ARGV[1])');
  if (!cas) return original(commands);
  const [, , , members, directory, key, was, next, listed, at] = commands[0].map(String);
  const [cur] = await original([["HGET", members, key]]);
  if (cur !== was) return [0];
  await original([["HSET", members, key, next], listed === "1" ? ["ZADD", directory, at, key] : ["ZREM", directory, key]]);
  return [1];
}

/** Every pipeline goes to `hook` first; it answers, or returns undefined to let the stub answer. */
function intercept(hook: ((commands: Commands) => unknown) | null): void {
  redis.pipeline = (async (commands: Commands) => {
    const reply = hook ? await hook(commands) : undefined;
    return reply === undefined ? stub(commands) : reply;
  }) as typeof redis.pipeline;
}

/** Who got an email whose subject holds `subject`, sorted, one entry per email. */
const to = (subject: string) => mail.sent.filter((m) => m.subject.includes(subject)).flatMap((m) => m.to).sort();
/** The stop-link tokens in the emails whose subject holds `subject`. */
const tokens = (subject: string) =>
  mail.sent.filter((m) => m.subject.includes(subject)).map((m) => /unsubscribe\?c=([0-9a-f]{40})/.exec(`${m.text ?? ""} ${m.html ?? ""}`)?.[1] ?? "");

async function main(): Promise<void> {
  intercept(null);
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "sends", "Sends proof", "A community.");
  await ensureListId(OWNER);
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Sends000001", subscriptionId: "sub_Sends000001", active: true, tier: "pro", period: paidPeriod() } as never);
  await setMailSettings(OWNER, { fromName: "Sends proof", address: "1 Test Street" });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  // One paid product opens the community; each member's answer for it is kept already (lib/community-access.ts), so
  // nothing is asked of Stripe unless a test takes that answer away. The store has a Stripe account, and Stripe
  // cannot be reached here: an answer not kept is one that cannot be had.
  await saveConfig(id, { ...freshConfig(store.name), access: [TICKET] });
  const load = async (handle: string): Promise<Store | null> => {
    const found = await storeForHandle(handle);
    return found && { ...found, stripeAccountId: "acct_1SendsSynthetic00", catalog: { ...found.catalog, items: [...found.catalog.items, { id: TICKET, kind: KIND.paid } as never] } };
  };
  const loaded = (await load(store.handle))!;
  const everyone = ["member000@example.com", "member001@example.com"];
  const MEMBERS = `nl:cm:${id}:m`;
  const members: Member[] = [];
  for (const [i, email] of everyone.entries()) members.push({ ...(await touchMember(id, email, null, store))!, mail: true, t: String(i + 1).repeat(40) });
  const okKey = (m: Member) => `nl:cm:${id}:ok:${m.k}`;
  const holds = async (m: Member, ok: boolean | null) =>
    original([ok === null ? ["DEL", okKey(m)] : ["SET", okKey(m), JSON.stringify({ v: 1, ok })]]);
  /** Writes both members as they started, each let in. */
  async function fresh(): Promise<void> {
    for (const m of members) {
      await original([["HSET", MEMBERS, m.k, JSON.stringify(m)], ["SET", `nl:cm:unsub:${m.t}`, `${id}|${m.k}|${store.handle}`]]);
      await holds(m, true);
    }
  }
  await fresh();

  /** One run of the community's emails, as the five-minute job does; what it threw, or "" when it did not. */
  async function step(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  }

  // ------------------------------------------------------------ announcements
  /** An announcement titled `title`, written down to go now (nothing sent yet). */
  async function announce(title: string): Promise<string> {
    const post = { id: createHash("sha256").update(title).digest("hex").slice(0, 12), title, text: "A synthetic announcement." } as Post;
    const queued = await queueAnnouncement(loaded, freshConfig(store.name), post);
    if (!queued.ok) throw new Error(`no synthetic announcement: ${queued.reason}`);
    return queued.job.id;
  }
  const advance = (job: string) => step(() => advanceAnnouncement(job, load, Date.now() + 20_000));
  const announcement = async (job: string) => {
    const read = await readJob(job);
    return [read?.status === "sent", read?.done, read?.total];
  };
  const inMailq = async (job: string) => ((await original([["SISMEMBER", MAILQ, job]]))[0] as number) === 1;
  /** A single HMGET of `key`, answered by `reply` from what the stub would have answered. */
  const onHmget = (key: string, reply: (real: unknown[]) => unknown) =>
    intercept(async (c) => (c.length === 1 && c[0][0] === "HMGET" && c[0][1] === key ? reply(await original(c)) : undefined));

  part("Control: an announcement whose members read goes once to everyone who asked");
  {
    const job = await announce("Control news");
    await advance(job);
    await advance(job);
    is("each got it once", [to("Control news"), ...(await announcement(job)), await inMailq(job)], [everyone, true, 2, 2, false]);
  }

  /** One run with the members' HMGET answered by `reply`, then plain runs: nobody emailed at first, each once after. */
  async function heldThenSent(title: string, reply: (real: unknown[]) => unknown, what: string): Promise<void> {
    const job = await announce(title);
    onHmget(MEMBERS, reply);
    try {
      is(`${what}: the batch is not done, the send kept queued, nobody emailed`, [await advance(job), ...(await announcement(job)), await inMailq(job), to(title)], ["", false, 0, 2, true, []]);
    } finally {
      intercept(null);
    }
    await advance(job);
    await advance(job);
    is(`${what}: the next run emails each of them once`, [to(title), ...(await announcement(job)), await inMailq(job)], [everyone, true, 2, 2, false]);
  }

  part("Announcements: a members read that does not come back exactly is not a batch of people who are gone");
  await heldThenSent("Lost news", () => [], "the members' HMGET lost");
  await heldThenSent("Shapeless news", () => ["QUEUED"], "the members' HMGET in another shape");
  await heldThenSent("Short news", (real) => [(real[0] as unknown[]).slice(0, 1)], "the members' HMGET with a short reply list");
  await heldThenSent("Odd news", (real) => [[(real[0] as unknown[])[0], 7]], "a member's row neither a record nor nil");

  part("Announcements: a ticket Stripe could not be asked about is not a member let in no more");
  {
    const job = await announce("Unasked news");
    await holds(members[1], null);
    is("the batch waits whole, nobody emailed", [await advance(job), ...(await announcement(job)), await inMailq(job), to("Unasked news")], ["", false, 0, 2, true, []]);
    await holds(members[1], true);
    await advance(job);
    await advance(job);
    is("once it can be asked, each is emailed once", [to("Unasked news"), ...(await announcement(job)), await inMailq(job)], [everyone, true, 2, 2, false]);
  }

  part("Announcements: a stop link is the one the member's record keeps");
  {
    // The second member has no token yet: one is made now, and their record does not read back while it is kept.
    await original([["HSET", MEMBERS, members[1].k, JSON.stringify({ ...members[1], t: "" })]]);
    const job = await announce("Token news");
    intercept((c) => (c.length === 1 && c[0][0] === "HGET" && c[0][1] === MEMBERS && c[0][2] === members[1].k ? [] : undefined));
    try {
      is("a token not kept sends nobody in the batch", [await advance(job), ...(await announcement(job)), await inMailq(job), to("Token news")], ["", false, 0, 2, true, []]);
    } finally {
      intercept(null);
    }
    await advance(job);
    await advance(job);
    is("the next run emails each once", [to("Token news"), ...(await announcement(job))], [everyone, true, 2, 2]);
    const links = await Promise.all(tokens("Token news").map((t) => readCommunityUnsub(t)));
    is("every stop link sent leads to its member", links.map((l) => l?.member.e ?? null).sort(), everyone);
    await fresh();
  }

  part("Controls: a member really gone, no longer asking, or let in no more is skipped; the others get it once");
  {
    const job = await announce("Gone news");
    await original([["HDEL", MEMBERS, members[1].k]]);
    await advance(job);
    await advance(job);
    is("a member whose record is gone (nil) is skipped", [to("Gone news"), ...(await announcement(job))], [[everyone[0]], true, 2, 2]);
    await fresh();
  }
  {
    const job = await announce("Stopped news");
    await original([["HSET", MEMBERS, members[0].k, JSON.stringify({ ...members[0], mail: false })]]);
    await advance(job);
    await advance(job);
    is("a member who stopped the emails since is skipped", [to("Stopped news"), ...(await announcement(job))], [[everyone[1]], true, 2, 2]);
    await fresh();
  }
  {
    const job = await announce("Lapsed news");
    await holds(members[0], false);
    await advance(job);
    await advance(job);
    is("a member whose ticket is known to have lapsed is skipped", [to("Lapsed news"), ...(await announcement(job))], [[everyone[1]], true, 2, 2]);
    await fresh();
  }

  // ------------------------------------------------------------ event reminders
  const rsvps = (e: CommunityEvent) => `nl:cm:${id}:ev:${e.id}:r`;
  const eventOk = (e: CommunityEvent, m: Member) => `nl:cm:${id}:ev:${e.id}:ok:${m.k}`;
  /** An event three days off with both members coming, open to `only`. */
  async function event(title: string, only: string[] = []): Promise<CommunityEvent> {
    const start = Math.floor((realNow() + 3 * DAY) / HOUR) * HOUR;
    const made = await createEvent(loaded, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only, start, cap: 0 }, realNow());
    if (!made.ok) throw new Error("no synthetic event");
    await original([["HSET", rsvps(made.event), ...members.flatMap((m, i) => [m.k, String(100 + i)])]]);
    return made.event;
  }
  /** The day-before reminder of `e`, made due now; its send's id, as startJob names it. */
  async function due(e: CommunityEvent): Promise<string> {
    await original([["ZADD", EVENT_QUEUE, 0, `${id}|${store.handle}|${e.id}|24|${e.start}`]]);
    return createHash("sha256").update(`${id}|${e.id}|24|${e.start}`).digest("hex").slice(0, 24);
  }
  const run = () => step(() => runEventQueue(load, Date.now() + 20_000, { mail: true }));
  const reminder = (title: string) => to(`Tomorrow: ${title}`);
  const sendState = async (job: string) => {
    const read = await readEventJob(job);
    return [read?.status, read?.done, read?.total, ((await original([["SISMEMBER", JOBS, job]]))[0] as number) === 1];
  };

  part("Control: a reminder whose answers read goes once to everyone coming");
  {
    const e = await event("Control call");
    const job = await due(e);
    await run();
    await run();
    is("each reminded once", [reminder("Control call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
  }

  part("Reminders: a ticket or an event's door Stripe could not be asked about is not a no");
  {
    const e = await event("Unasked call");
    const job = await due(e);
    await holds(members[1], null);
    is("a ticket unasked: the batch waits whole, nobody reminded", [await run(), ...(await sendState(job)), reminder("Unasked call")], ["", "sending", 0, 2, true, []]);
    await holds(members[1], true);
    await run();
    await run();
    is("once it can be asked, each is reminded once", [reminder("Unasked call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
  }
  {
    const e = await event("Door call", [TICKET]);
    const job = await due(e);
    await original([["SET", eventOk(e, members[0]), JSON.stringify({ v: `1.${e.v}`, ok: true })]]);
    is("an event's door unasked: the batch waits whole, nobody reminded", [await run(), ...(await sendState(job)), reminder("Door call")], ["", "sending", 0, 2, true, []]);
    await original([["SET", eventOk(e, members[1]), JSON.stringify({ v: `1.${e.v}`, ok: true })]]);
    await run();
    await run();
    is("once it can be asked, each is reminded once", [reminder("Door call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
  }
  {
    const e = await event("Shut call", [TICKET]);
    const job = await due(e);
    await original([["SET", eventOk(e, members[0]), JSON.stringify({ v: `1.${e.v}`, ok: true })]]);
    await original([["SET", eventOk(e, members[1]), JSON.stringify({ v: `1.${e.v}`, ok: false })]]);
    await run();
    await run();
    is("control: a door known shut leaves that member out, the other reminded once", [reminder("Shut call"), ...(await sendState(job))], [[everyone[0]], "sent", 2, 2, false]);
  }

  part("Reminders: a stop link is the one the member's record keeps");
  {
    await original([["HSET", MEMBERS, members[1].k, JSON.stringify({ ...members[1], t: "" })]]);
    const e = await event("Token call");
    const job = await due(e);
    intercept((c) => (c.length === 1 && c[0][0] === "HGET" && c[0][1] === MEMBERS && c[0][2] === members[1].k ? [] : undefined));
    try {
      is("a token not kept sends nobody in the batch", [await run(), ...(await sendState(job)), reminder("Token call")], ["", "sending", 0, 2, true, []]);
    } finally {
      intercept(null);
    }
    await run();
    await run();
    is("the next run reminds each once", [reminder("Token call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
    const links = await Promise.all(tokens("Tomorrow: Token call").map((t) => readCommunityUnsub(t)));
    is("every stop link sent leads to its member", links.map((l) => l?.member.e ?? null).sort(), everyone);
    await fresh();
  }

  part("Controls: a member really gone or let in no more is left out of a reminder; the other gets it once");
  {
    const e = await event("Gone call");
    const job = await due(e);
    await original([["HDEL", MEMBERS, members[1].k]]);
    await run();
    await run();
    is("a member whose record is gone (nil) is skipped", [reminder("Gone call"), ...(await sendState(job))], [[everyone[0]], "sent", 2, 2, false]);
    await fresh();
  }
  {
    const e = await event("Lapsed call");
    const job = await due(e);
    await holds(members[0], false);
    await run();
    await run();
    is("a member whose ticket is known to have lapsed is skipped", [reminder("Lapsed call"), ...(await sendState(job))], [[everyone[1]], "sent", 2, 2, false]);
    await fresh();
  }

  done();
}

void main();
