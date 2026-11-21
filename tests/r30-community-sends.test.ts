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
 *
 * Claude 2's review of #3140 at 4ea029d30:
 * - M1: a reminder whose readers were written but whose send was not (the job's SET failed) kept its `:made` claim;
 *   the next run found the claim, read no send, and the entry was taken off the queue unsent. And a send's own record
 *   was read without repliesFor, so a lost reply took a send under way off nl:cm:evmailq for good.
 * - M2: with `strict`, one member who can never be resolved (Stripe has more than one page of their checkouts, more
 *   than ten customers, or the store's Stripe account is disconnected) held a whole announcement or reminder: nobody
 *   after them was emailed, ever. Now such a member is left out of the batch, counted as skipped (never as sent), and
 *   the others go on; a member Stripe keeps failing to answer for is treated so after MEMBER_TRIES tries in a row.
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
    return found && { ...found, stripeAccountId: "acct_1SendsSynth0", catalog: { ...found.catalog, items: [...found.catalog.items, { id: TICKET, kind: KIND.paid } as never] } };
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

  // ------------------------------------------------------------ review of #3140, M1
  const evJob = (job: string) => `nl:cm:evmail:${job}`;
  const evMade = (job: string) => `nl:cm:evmail:${job}:made`;
  /** Fails the first pipeline that matches, once; `land` lets the stub apply it first (a reply lost after it landed). */
  const failOnce = (match: (c: Commands) => boolean, land = false) => {
    let fired = false;
    intercept(async (c) => {
      if (fired || !match(c)) return undefined;
      fired = true;
      if (land) await stub(c);
      throw new Error("Redis request failed with status 503");
    });
  };
  const setsJob = (job: string) => (c: Commands) => c.some((x) => x[0] === "SET" && x[1] === evJob(job));
  const inQueue = async (e: CommunityEvent) =>
    ((await original([["ZRANGEBYSCORE", EVENT_QUEUE, 0, "+inf"]]))[0] as string[]).some((m) => m.includes(`|${e.id}|24|`));

  part("Review M1: a reminder whose readers were written but whose send was not is started again, never dropped");
  {
    const e = await event("Unsaved call");
    const job = await due(e);
    failOnce(setsJob(job));
    try {
      is("the failed start leaves the entry queued, nobody reminded", [await run(), await inQueue(e), reminder("Unsaved call")], ["", true, []]);
    } finally {
      intercept(null);
    }
    await run();
    await run();
    is("the next runs remind each once, and the send is done", [reminder("Unsaved call"), ...(await sendState(job)), await inQueue(e)], [everyone, "sent", 2, 2, false, false]);
  }
  {
    const e = await event("Stuck claim call");
    const job = await due(e);
    // The send is not written, and giving its claim back fails too: the claim outlives the start that took it.
    let dels = 0;
    intercept(async (c) => {
      if (setsJob(job)(c) && dels === 0) throw new Error("Redis request failed with status 503");
      // Giving the claim back is a compare and delete of it (releaseMark's EVAL), or a DEL of it: either fails here.
      if (c.some((x) => (x[0] === "DEL" || x[0] === "EVAL") && x.includes(evMade(job))) && dels === 0) {
        dels += 1;
        throw new Error("Redis request failed with status 503");
      }
      return undefined;
    });
    try {
      await run();
    } finally {
      intercept(null);
    }
    await run();
    is("a claim with no send written behind it keeps the entry queued, nobody reminded", [await inQueue(e), reminder("Stuck claim call")], [true, []]);
    const ttl = (await original([["TTL", evMade(job)]]))[0] as number;
    is("that claim lapses on its own within five minutes", ttl > 0 && ttl <= 300, true);
    redis.advance(301_000);
    await run();
    await run();
    is("once it lapses, the reminder is started and each reminded once", [reminder("Stuck claim call"), ...(await sendState(job)), await inQueue(e)], [everyone, "sent", 2, 2, false, false]);
  }
  {
    const e = await event("Landed call");
    const job = await due(e);
    failOnce(setsJob(job), true);
    try {
      await run();
    } finally {
      intercept(null);
    }
    await run();
    await run();
    is("control: a send written whose reply was lost goes out once to each", [reminder("Landed call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
  }
  {
    const e = await event("Lost record call");
    const job = await due(e);
    // Made and queued, nothing sent: another run holds the send's lock for this one.
    const lock = `nl:cm:evmail:${job}:lock`;
    intercept((c) => (c.length === 1 && c[0][0] === "SET" && c[0][1] === lock ? [null] : undefined));
    try {
      await run();
    } finally {
      intercept(null);
    }
    is("made and queued, nobody reminded yet", [((await original([["SISMEMBER", JOBS, job]]))[0] as number) === 1, reminder("Lost record call")], [true, []]);
    // The send's own record answers nothing once, as it is moved on.
    let lost = false;
    intercept((c) => (!lost && c.length === 1 && c[0][0] === "GET" && c[0][1] === evJob(job) ? ((lost = true), []) : undefined));
    try {
      await run();
    } finally {
      intercept(null);
    }
    is("a send whose record did not read stays among the sends under way", ((await original([["SISMEMBER", JOBS, job]]))[0] as number) === 1, true);
    await run();
    is("and goes out once to each", [reminder("Lost record call"), ...(await sendState(job))], [everyone, "sent", 2, 2, false]);
  }

  // ------------------------------------------------------------ review of #3140, M2
  // Stripe, played here for the second member only: the first member's answer is kept, so Stripe is never asked of them.
  const TRIES = 6; // MEMBER_TRIES, lib/community-mail.ts
  let stripe: ((path: string) => { status: number; body: unknown }) | null = null;
  /** The Stripe paths asked, in order. */
  const asked: string[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.stripe.com/v1/")) return before(input, init);
    if (!stripe) throw new TypeError("fetch failed");
    asked.push(url.slice("https://api.stripe.com/v1".length));
    const { status, body } = stripe(url.slice("https://api.stripe.com/v1".length));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  process.env.STRIPE_SECRET_KEY = "sk_test_syntheticSends";
  const list = (data: unknown[], hasMore = false) => ({ status: 200, body: { object: "list", data, has_more: hasMore } });
  const session = (n: number) => ({
    id: `cs_test_Synth${String(n).padStart(4, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    customer: `cus_Synth${String(n).padStart(6, "0")}`,
    metadata: { store: store.handle, product: "otherproduct" },
  });
  const unresolvable: [string, (path: string) => { status: number; body: unknown }][] = [
    ["more than one page of checkouts", (path) => (path.startsWith("/checkout/sessions") ? list([], true) : list([]))],
    ["more than ten customers", (path) => (path.startsWith("/checkout/sessions") ? list(Array.from({ length: 11 }, (_, n) => session(n))) : list([]))],
    [
      "a disconnected Stripe account",
      () => ({ status: 403, body: { error: { type: "invalid_request_error", code: "account_invalid", message: "The provided key does not have access to account (synthetic)." } } }),
    ],
  ];
  const skippedOf = async (job: string) => ((await readJob(job)) as { skipped?: number } | null)?.skipped;
  const sentOf = async (job: string) => (await readJob(job))?.sent;
  try {
    part("Review M2: one member who can never be resolved does not hold a whole announcement");
    for (const [what, answer] of unresolvable) {
      const title = `Unresolvable news ${what}`;
      const job = await announce(title);
      await holds(members[1], null);
      stripe = answer;
      asked.length = 0;
      await advance(job);
      await advance(job);
      if (what === "more than ten customers") {
        is(`${what}: the ten customers read are asked of, no more`, asked.filter((p) => p.startsWith("/payment_intents")).length, 10);
      }
      is(`${what}: the others are emailed once, the send is done`, [to(title), ...(await announcement(job)), await inMailq(job)], [[everyone[0]], true, 2, 2, false]);
      is(`${what}: that member is counted skipped, never sent`, [await sentOf(job), await skippedOf(job)], [1, 1]);
      stripe = null;
      await fresh();
    }

    part("Review M2: a member Stripe keeps failing to answer for holds the batch only MEMBER_TRIES tries");
    {
      const title = "Failing news";
      const job = await announce(title);
      await holds(members[1], null);
      stripe = () => ({ status: 500, body: { error: { type: "api_error", message: "synthetic" } } });
      for (let i = 1; i < TRIES; i++) await advance(job);
      is("before the last try, the batch waits whole and nobody is emailed", [to(title), ...(await announcement(job)), await inMailq(job)], [[], false, 0, 2, true]);
      await advance(job);
      await advance(job);
      is("after it, the others are emailed once and the member is skipped", [to(title), ...(await announcement(job)), await sentOf(job), await skippedOf(job)], [[everyone[0]], true, 2, 2, 1, 1]);
      stripe = null;
      await fresh();
    }
    {
      const title = "Recovered news";
      const job = await announce(title);
      await holds(members[1], null);
      stripe = () => ({ status: 500, body: { error: { type: "api_error", message: "synthetic" } } });
      for (let i = 1; i < TRIES; i++) await advance(job);
      stripe = null;
      await holds(members[1], true);
      await advance(job);
      await advance(job);
      is("control: a member answered before the last try is emailed, nobody skipped", [to(title), ...(await announcement(job)), await sentOf(job), await skippedOf(job) ?? 0], [everyone, true, 2, 2, 2, 0]);
      await fresh();
    }

    part("Review M2: one member who can never be resolved does not hold a reminder from the others");
    {
      const e = await event("Unresolvable call");
      const job = await due(e);
      await holds(members[1], null);
      stripe = unresolvable[0][1];
      await run();
      await run();
      const read = (await readEventJob(job)) as { sent?: number; skipped?: number } | null;
      is("the others are reminded once, the send is done", [reminder("Unresolvable call"), ...(await sendState(job))], [[everyone[0]], "sent", 2, 2, false]);
      is("that member is counted skipped, never sent", [read?.sent, read?.skipped], [1, 1]);
      stripe = null;
      await fresh();
    }
  } finally {
    globalThis.fetch = before;
    delete process.env.STRIPE_SECRET_KEY;
  }

  done();
}

void main();
