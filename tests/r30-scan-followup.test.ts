/**
 * Follow-ups of #3134 (rules 24 and 30; Claude 2's review, M2, M3 and L4), synthetic only.
 *
 * - M2, lib/community-event-mail.ts, runEventQueue: a due reminder stayed queued only when its list of who is coming
 *   threw UnknownReplyError. Any other error on the way (a timeout or an error status from Redis, the store not
 *   loading, the event not reading, the readers or the send not written down) took it off the queue unsent, and
 *   nothing tried it again: the hour-before reminder was simply lost. Now any error keeps it queued while it is still
 *   of use (the window of the due entry itself, so an error that never clears does not hold the queue for good), and
 *   it is sent once on a later run, never twice (the send's `:made` claim and its batch keys).
 * - M3, lib/community-events.ts rsvpList and lib/free.ts listAsCsv: HSCAN may hand the same field back twice during
 *   a walk. rsvpList listed that person twice: the studio's count was inflated, and a send's readers list held the
 *   same key twice, so recipientBatch refused that batch for good ("We couldn't read the remaining recipients") and
 *   nobody from it on was ever emailed. listAsCsv wrote the same address twice in the creator's download. Now each
 *   is kept once, the latest reading.
 * - L4, lib/free.ts listAsCsv: the page ceiling (MAX_LEADS / 500 + 10) was compared with `===`; with a MAX_LEADS
 *   that is not a multiple of 500 the walk would never stop on a cursor that never comes back to "0". Here MAX_LEADS
 *   is 100,250 (tests/r30-scan-followup-contact-rules.ts, aliased in tests/test-config.mjs).
 */
import { freshConfig, saveConfig, touchMember, type Member } from "@/lib/community";
import { EVENT_QUEUE, createEvent, rsvpList, type CommunityEvent } from "@/lib/community-events";
import { queueEventNotice, readEventJob, runEventQueue } from "@/lib/community-event-mail";
import { listAsCsv } from "@/lib/free";
import { leadsKey } from "@/lib/contacts";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail, storeForHandle, type Store } from "@/lib/store";
import { emailKey } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Commands = (string | number)[][];
const OWNER = "followup-owner@example.com";
const GOING = ["ann@example.com", "bo@example.com"];
const mail = installSesMailFixture();
const original = redis.pipeline.bind(redis);
const realNow = Date.now.bind(Date);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
const isRsvpScan = (commands: Commands) => commands.length === 1 && commands[0][0] === "HSCAN" && /^nl:cm:[0-9a-f]{32}:ev:[0-9a-f]{12}:r$/.test(String(commands[0][1]));

/** Who got an email whose subject is `subject`, sorted, one entry per email. */
const to = (subject: string) => mail.sent.filter((m) => m.subject === subject).flatMap((m) => m.to).sort();

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, "followup", "Follow-up proof", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  // One product lets in, and both members hold it (the ticket's answer kept as the gate keeps it).
  const config = { ...freshConfig(store.name), access: [ticket.product.id] };
  await saveConfig(id, config);
  for (const email of GOING) await original([["SET", `nl:cm:${id}:ok:${emailKey(email)}`, JSON.stringify({ v: config.v, ok: true })]]);
  const members: Member[] = [];
  // Each asked for the community's emails (the "Email me" box) and holds a stop token, written straight into the
  // stub's hash: the stub has no EVAL for setMail's or setMemberToken's compare-and-set.
  for (const [i, email] of GOING.entries()) {
    const member = { ...(await touchMember(id, email, null, store))!, mail: true, t: String(i + 1).repeat(40) };
    await original([["HSET", `nl:cm:${id}:m`, member.k, JSON.stringify(member)]]);
    members.push(member);
  }

  /** An event three days off with both members coming, `title` its own so its emails are told apart. */
  async function event(title: string): Promise<CommunityEvent> {
    const start = Math.floor((realNow() + 3 * DAY) / HOUR) * HOUR;
    const made = await createEvent(store, { title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 }, realNow());
    if (!made.ok) throw new Error("no synthetic event");
    await original([["HSET", `nl:cm:${id}:ev:${made.event.id}:r`, members[0].k, "100", members[1].k, "200"]]);
    return made.event;
  }
  const hourDue = (e: CommunityEvent) => `${id}|${store.handle}|${e.id}|1|${e.start}`;
  const queued = async (member: string) => (await original([["ZSCORE", EVENT_QUEUE, member]]))[0] !== null;
  /** One run of the five-minute job's event part, half an hour before `e` starts (the hour-before reminder is due). */
  async function run(e: CommunityEvent, findStore: (handle: string) => Promise<Store | null> = storeForHandle, at = e.start - 30 * 60_000): Promise<void> {
    Date.now = () => at;
    try {
      await runEventQueue(findStore, at + 20_000, { mail: true });
    } finally {
      Date.now = realNow;
    }
  }
  /** Runs once under `hook`, then twice without it: [queued after the failing run, sent then, sent at the end]. */
  async function failingThenClear(title: string, hook: (commands: Commands) => unknown, findStore?: (handle: string) => Promise<Store | null>): Promise<[boolean, string[], string[]]> {
    const e = await event(title);
    intercept(hook);
    try {
      await run(e, findStore);
    } finally {
      intercept(null);
    }
    const kept = await queued(hourDue(e));
    const first = to(`In 1 hour: ${title}`);
    await run(e);
    await run(e);
    return [kept, first, to(`In 1 hour: ${title}`)];
  }

  part("Control: a due hour-before reminder is emailed once to each member coming who asked for emails");
  {
    const e = await event("Control night");
    await run(e);
    is("each got it once", to("In 1 hour: Control night"), GOING);
    await run(e);
    is("and never again, and it is off the queue", [to("In 1 hour: Control night"), await queued(hourDue(e))], [GOING, false]);
  }

  part("M2: a due reminder is not lost on an ordinary error; it stays queued and is sent once on a later run");
  is(
    "the list of who is coming throws (a timeout, an error status)",
    await failingThenClear("Thrown list", (c) => (isRsvpScan(c) ? fail() : undefined)),
    [true, [], GOING],
  );
  is(
    "the store does not load",
    await failingThenClear("Store unloaded", () => undefined, async () => fail()),
    [true, [], GOING],
  );
  is(
    "the event does not read",
    await failingThenClear("Event unread", (c) => (c.length === 1 && c[0][0] === "GET" && /^nl:cm:[0-9a-f]{32}:ev:[0-9a-f]{12}$/.test(String(c[0][1])) ? fail() : undefined)),
    [true, [], GOING],
  );
  is(
    "its readers are not written down",
    await failingThenClear("Readers unwritten", (c) => (c[0]?.[0] === "DEL" && String(c[0][1]).endsWith(":to") && c[1]?.[0] === "RPUSH" ? fail() : undefined)),
    [true, [], GOING],
  );
  {
    let once = true;
    is(
      "the send is written down but not put on the list of sends under way",
      await failingThenClear("Send unlisted", (c) => {
        if (once && c.length === 1 && c[0][0] === "SADD" && c[0][1] === "nl:cm:evmailq") {
          once = false;
          return fail();
        }
        return undefined;
      }),
      [true, [], GOING],
    );
  }
  {
    const e = await event("Never clears");
    intercept((c) => (isRsvpScan(c) ? fail() : undefined));
    try {
      await run(e);
      is("an error that does not clear keeps it queued while it is of use", await queued(hourDue(e)), true);
      await run(e, storeForHandle, e.start + 60_000);
      is("and no longer once the event has begun: it is taken off, never sent late", [await queued(hourDue(e)), to("In 1 hour: Never clears")], [false, []]);
    } finally {
      intercept(null);
    }
  }
  {
    const e = await event("Unknown forever");
    intercept((c) => (c.length === 1 && c[0][0] === "GET" && String(c[0][1]) === `nl:cm:${id}:ev:${e.id}` ? fail() : undefined));
    try {
      await run(e, storeForHandle, e.start + 60_000);
      is("an error past its window (the event not even read) takes it off: an entry never holds the queue for good", await queued(hourDue(e)), false);
    } finally {
      intercept(null);
    }
  }

  part("M3: a member HSCAN hands back twice is one person coming, counted once and emailed once");
  {
    const e = await event("Twice listed");
    const rsvp = `nl:cm:${id}:ev:${e.id}:r`;
    const twice = (c: Commands) => {
      if (!(c.length === 1 && c[0][0] === "HSCAN" && c[0][1] === rsvp)) return undefined;
      return c[0][2] === "0" ? [["7", [members[0].k, "100", members[1].k, "200"]]] : [["0", [members[0].k, "100"]]];
    };
    intercept(twice);
    try {
      is("rsvpList lists each member once", (await rsvpList(id, e.id)).map((r) => r.key).sort(), [members[0].k, members[1].k].sort());
      const job = await queueEventNotice(store, { ...e, moves: 1 }, "moved", { start: e.start - DAY, minutes: 60 });
      is("the move's send is for two people", job?.total, 2);
      intercept(null);
      Date.now = () => e.start - 2 * HOUR;
      try {
        await runEventQueue(storeForHandle, Date.now() + 20_000, { mail: true });
      } finally {
        Date.now = realNow;
      }
      is("each is emailed once, and the send is finished", [to("New time: Twice listed"), (await readEventJob(job!.id))?.status], [GOING, "sent"]);
    } finally {
      intercept(null);
    }
  }
  {
    const LIST = "b".repeat(32);
    const listStore = { listId: LIST, statsId: null } as unknown as Store;
    const contact = (agreed: boolean) => JSON.stringify({ agreed, agreedAt: "2026-11-01", firstAt: "2026-11-01", lastAt: "2026-11-01", titles: ["Guide"], ids: [], source: "free" });
    intercept((c) => {
      if (!(c.length === 1 && c[0][0] === "HSCAN" && c[0][1] === leadsKey(LIST))) return undefined;
      return c[0][2] === "0" ? [["9", ["one@example.com", contact(false), "two@example.com", contact(true)]]] : [["0", ["one@example.com", contact(true)]]];
    });
    try {
      const rows = async (onlyAgreed: boolean) => (await listAsCsv(listStore, onlyAgreed)).trim().split("\r\n").slice(1).map((row) => row.split(",").map((c) => c.replace(/^"|"$/g, "")));
      const all = await rows(false);
      is("listAsCsv writes each address once", all.map((row) => row[0]).sort(), ["one@example.com", "two@example.com"]);
      is("as last read", all.filter((row) => row[0] === "one@example.com").map((row) => row[1]), ["yes"]);
      const agreed = await rows(true);
      is("and once among those who agreed", agreed.map((row) => row[0]).sort(), ["one@example.com", "two@example.com"]);
    } finally {
      intercept(null);
    }
  }

  part("L4: listAsCsv's page ceiling holds when it is not a whole number (MAX_LEADS 100,250 here)");
  {
    const listStore = { listId: "c".repeat(32), statsId: null } as unknown as Store;
    let scans = 0;
    intercept((c) => {
      if (!(c.length === 1 && c[0][0] === "HSCAN")) return undefined;
      // A guard for the test itself: a walk past a thousand pages is one that does not stop.
      if (++scans > 1000) throw new Error("the walk does not stop");
      return [["5", []]];
    });
    let got = "";
    try {
      await listAsCsv(listStore, false);
      got = "whole";
    } catch (error) {
      got = error instanceof UnknownReplyError ? "unknown" : String((error as Error).message);
    } finally {
      intercept(null);
    }
    is("a cursor that never comes back to 0 is unknown after 211 pages", [got, scans], ["unknown", 211]);
  }

  done();
}

void main();
