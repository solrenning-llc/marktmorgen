/**
 * A community send's claims read exactly (CX-123 rule 24, lib/claim-mark.ts): the lock that lets one run move an
 * announcement or an event email on, and the mark that makes a move, cancellation or reminder once. "OK", or our own
 * value read back, is ours; nil is another run's; anything else is unknown, and nothing is sent, reset or let go on it.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { advanceEventJob, queueEventNotice, runEventQueue, type EventMailJob } from "@/lib/community-event-mail";
import { db, event, members, reset, sent, setRsvpUnknown, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

type Command = (string | number)[];
const original = db.pipeline.bind(db);
/** The SET NX on `key` answered by `answer` (given whether it wrote); every other command as the stand-in answers it. */
function claimAnswers(key: string, answer: (wrote: boolean) => unknown[] | Error, read?: () => unknown[]) {
  db.pipeline = async (commands: Command[]) => {
    const [first] = commands;
    if (commands.length === 1 && first[0] === "SET" && first[1] === key && first.includes("NX")) {
      const wrote = (await original(commands))[0] === "OK";
      const reply = answer(wrote);
      if (reply instanceof Error) throw reply;
      return reply;
    }
    if (read && commands.length === 1 && first[0] === "GET" && first[1] === key) return read();
    return original(commands);
  };
}
const restore = () => { db.pipeline = original; };

const id = "e".repeat(24);
const keys = members.map((m) => m.k);
const job = { id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", event: event.id, kind: "cancelled",
  start: event.start, was: 0, wasMinutes: 0, total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
} as AnnouncementJob & EventMailJob;

async function main(): Promise<void> {
  for (const kind of ["announcement", "event"] as const) {
    const prefix = kind === "announcement" ? "nl:cm:mail:" : "nl:cm:evmail:";
    const queue = kind === "announcement" ? "nl:cm:mailq" : "nl:cm:evmailq";
    const advance = kind === "announcement" ? advanceAnnouncement : advanceEventJob;
    const lock = `${prefix}${id}:lock`;
    const seed = () => {
      reset();
      db.run(["SET", prefix + id, JSON.stringify(job)]);
      db.run(["RPUSH", prefix + id + ":to", ...keys]);
      db.run(["SADD", queue, id]);
    };

    part(`${kind}: the send's lock`);
    for (const [label, reply] of [["undefined", [undefined]], ["no reply", []], ["text", ["QUEUED"]], ["a number", [1]]] as const) {
      seed();
      db.run(["SET", lock, "another-run", "EX", 90]);
      claimAnswers(lock, () => [...reply]);
      let result: unknown = "threw";
      try { result = await advance(id, async () => store, Date.now() + 10_000); } catch { /* nothing sent is what counts */ }
      restore();
      is(`${label} while another run holds it: nothing sent`, sent.length, 0);
      is(`${label} while another run holds it: its lock is left to it`, db.run(["GET", lock]), "another-run");
      is(`${label} while another run holds it: the job is untouched`, [result === null || result === "threw", JSON.parse(String(db.run(["GET", prefix + id]))).done], [true, 0]);
    }

    seed();
    claimAnswers(lock, () => new Error("synthetic lost reply"));
    let lost: unknown = "threw";
    try { lost = await advance(id, async () => store, Date.now() + 10_000); } catch { /* checked below */ }
    restore();
    is("a lock taken whose reply was lost: read back as ours, the send goes once", [(lost as AnnouncementJob | null)?.status, sent.length], ["sent", 1]);
    is("a lock taken whose reply was lost: let go after", db.run(["GET", lock]), null);

    seed();
    claimAnswers(lock, () => [undefined], () => [undefined]);
    let unknown: unknown = "threw";
    try { unknown = await advance(id, async () => store, Date.now() + 10_000); } catch { /* nothing sent is what counts */ }
    restore();
    is("a lock answered and read back in no known shape: nothing sent this run", [sent.length, unknown === null || unknown === "threw"], [0, true]);

    seed();
    const healthy = await advance(id, async () => store, Date.now() + 10_000);
    is("healthy: the send goes once and the lock is let go", [healthy?.status, sent.length, db.run(["GET", lock])], ["sent", 1, null]);

    seed();
    db.run(["SET", lock, "another-run", "EX", 90]);
    const busy = await advance(id, async () => store, Date.now() + 10_000);
    is("held by another run (nil): nothing sent, its lock kept", [busy, sent.length, db.run(["GET", lock])], [null, 0, "another-run"]);
  }

  part("event: the once-only mark of a move or cancellation");
  const notice = async () => {
    try { return await queueEventNotice(store, event, "cancelled", null); } catch { return "threw" as const; }
  };
  reset();
  const first = await notice();
  is("healthy: the notice is made once", [typeof first === "object" && first?.total, db.run(["SCARD", "nl:cm:evmailq"])], [2, 1]);
  const made = (first as EventMailJob).id;
  const madeKey = `nl:cm:evmail:${made}:made`;
  is("healthy: asked again it is taken, nothing made again", await notice(), null);

  // The first send has gone part of the way: an unknown answer must not start it again from nobody told.
  db.run(["SET", `nl:cm:evmail:${made}`, JSON.stringify({ ...(first as EventMailJob), done: 1, sent: 1 })]);
  for (const [label, reply] of [["undefined", [undefined]], ["no reply", []], ["text", ["QUEUED"]]] as const) {
    claimAnswers(madeKey, () => [...reply]);
    const again = await notice();
    restore();
    const saved = JSON.parse(String(db.run(["GET", `nl:cm:evmail:${made}`])));
    is(`${label} on a mark already made: the send under way is not started again`, [again === null || again === "threw", saved.done, saved.sent], [true, 1, 1]);
  }

  reset();
  claimAnswers(`nl:cm:evmail:${made}:made`, () => new Error("synthetic lost reply"));
  const landed = await notice();
  restore();
  is("a mark written whose reply was lost: read back as ours, the notice is made", [typeof landed === "object" && landed?.total, db.run(["SCARD", "nl:cm:evmailq"])], [2, 1]);

  reset();
  claimAnswers(`nl:cm:evmail:${made}:made`, () => [undefined], () => [undefined]);
  const unknown = await notice();
  restore();
  is("a mark answered and read back in no known shape: no notice made on it", [unknown === null || unknown === "threw", db.run(["SCARD", "nl:cm:evmailq"])], [true, 0]);
  is("...and the mark is not left behind as ours, so asking again makes it", typeof (await notice()) === "object", true);

  part("event: a reminder due whose mark is unknown stays in line");
  reset();
  const due = `${store.community!.id}|${store.handle}|${event.id}|24|${event.start}`;
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  const reminder = `nl:cm:evmail:${(await import("node:crypto")).createHash("sha256").update(`${store.community!.id}|${event.id}|24|${event.start}`).digest("hex").slice(0, 24)}:made`;
  claimAnswers(reminder, () => [undefined], () => [undefined]);
  const run = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  restore();
  is("unknown: no reminder made or sent, and it is still due", [run.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [0, 0, 1]);
  const next = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("the next run makes it and sends it, once", [next.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [1, 1, 0]);

  // Codex P on #2954: a mark whose release is unknown too is left behind with no send made. "Taken" is made only
  // when the send itself is there; a mark with no send stays due, and one left long enough is taken over and made.
  part("event: a mark left with no send made does not drop the reminder");
  const answerOnly = (pick: (c: Command) => Promise<unknown[] | undefined> | unknown[] | undefined) => {
    db.pipeline = async (commands: Command[]) => (commands.length === 1 ? await pick(commands[0]) : undefined) ?? original(commands);
  };
  reset();
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  answerOnly(async (c) => {
    if (c[0] === "SET" && c[1] === reminder && c.includes("NX")) { await original([c]); return [undefined]; }
    if (c[0] === "GET" && c[1] === reminder) return [undefined];
    if (c[0] === "EVAL" && c[3] === reminder) return [undefined];
    return undefined;
  });
  const lost = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  restore();
  is("claim and release unknown: nothing made or sent, still due", [lost.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [0, 0, 1]);
  const soon = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("the next run finds the mark but no send: the reminder stays due, never dropped as made", [soon.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [0, 0, 1]);
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  try {
    const later = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
    is("once the mark is old enough to belong to no run still going, it is taken over and the reminder sent once", [later.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [1, 1, 0]);
  } finally {
    Date.now = realNow;
  }
  reset();
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  const going = `${Date.now()}.000000001`;
  db.run(["SET", reminder, going, "EX", 2_592_000]);
  const young = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("a fresh mark with no send (a run still making it): still due, nothing sent, the mark left to it", [young.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"]), db.run(["GET", reminder])], [0, 0, 1, going]);

  // Claude 5 on #2954, LIGHT 1: a failure after the mark is ours lets it go, so the reminder is made on the next run.
  part("event: a failure after the mark is ours keeps the reminder");
  reset();
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  let failOnce = true;
  answerOnly((c) => {
    if (failOnce && c[0] === "SET" && String(c[1]).startsWith("nl:cm:evmail:") && !String(c[1]).endsWith(":made") && !c.includes("NX")) { failOnce = false; throw new Error("synthetic lost write"); }
    return undefined;
  });
  const broke = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  restore();
  is("the send's record not written: nothing sent, still due", [broke.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [0, 0, 1]);
  const mended = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("the next run makes it and sends it, once", [mended.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [1, 1, 0]);

  // Claude 5 on #2954, MEDIUM 1: who is coming read in an unknown shape makes nothing and takes no mark.
  part("event: who is coming unknown keeps the reminder");
  reset();
  db.run(["ZADD", "nl:cm:evq", 1, due]);
  setRsvpUnknown(true);
  const blind = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("unknown readers: nothing made, no mark taken, still due", [blind.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"]), db.run(["GET", reminder])], [0, 0, 1, null]);
  const seen = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
  is("the next run makes it and sends it to both, once", [seen.reminders, sent.flat().length, db.run(["ZCARD", "nl:cm:evq"])], [1, 2, 0]);

  // Codex P on #2954 (focal return): a send's record read back as text that is not this send is unknown, never
  // "made": the reminder stays due, nothing is sent, and the aged mark is not taken over on that read.
  part("event: a taken mark whose send reads back as something else keeps the reminder");
  const sendKey = reminder.slice(0, -":made".length);
  const otherSend = JSON.stringify({ ...job, id: "a".repeat(24), kind: "24" });
  // Codex P on #2954 (second focal return): this send's id alone, or with fields this code never writes, is a
  // partial record, not a send; it is unknown too.
  const reminderId = sendKey.slice("nl:cm:evmail:".length);
  const partial: (readonly [string, string])[] = [
    ["only this send's id", JSON.stringify({ id: reminderId })],
    ["this send's id with a status this code never writes", JSON.stringify({ id: reminderId, status: 12 })],
    ["this send written down as sent, cut short", JSON.stringify({ id: reminderId, status: "sent", total: 1 })],
  ];
  for (const [name, text] of [["cut text", "{cut"], ["an id this code never writes", '{"id":"invalid"}'], ["another send's record", otherSend], ["a JSON list", "[1]"], ...partial] as const) {
    reset();
    db.run(["ZADD", "nl:cm:evq", 1, due]);
    const aged = `${Date.now() - 20 * 60_000}.000000001`;
    db.run(["SET", reminder, aged, "EX", 2_592_000]);
    db.pipeline = async (commands: Command[]) => {
      if (commands.length === 2 && commands[1][0] === "GET" && commands[1][1] === sendKey) return [(await original([commands[0]]))[0], text];
      return original(commands);
    };
    const odd = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
    restore();
    is(`${name}: nothing made or sent, still due, the mark untouched`, [odd.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"]), db.run(["GET", reminder])], [0, 0, 1, aged]);
    const healed = await runEventQueue(async () => store, Date.now() + 10_000, { mail: true });
    is(`${name}: read again with no send there, the aged mark is taken over and the reminder sent once`, [healed.reminders, sent.length, db.run(["ZCARD", "nl:cm:evq"])], [1, 1, 0]);
  }

  // Claude 5 on #2954, MEDIUM 2: the send's own record read in an unknown shape under the lock leaves it in line.
  for (const kind of ["announcement", "event"] as const) {
    part(`${kind}: the send's record unknown under the lock`);
    const prefix = kind === "announcement" ? "nl:cm:mail:" : "nl:cm:evmail:";
    const queue = kind === "announcement" ? "nl:cm:mailq" : "nl:cm:evmailq";
    const advance = kind === "announcement" ? advanceAnnouncement : advanceEventJob;
    reset();
    db.run(["SET", prefix + id, JSON.stringify(job)]);
    db.run(["RPUSH", prefix + id + ":to", ...keys]);
    db.run(["SADD", queue, id]);
    answerOnly((c) => (c[0] === "GET" && c[1] === prefix + id ? [undefined] : undefined));
    let blank: unknown = "threw";
    try { blank = await advance(id, async () => store, Date.now() + 10_000); } catch { /* checked below */ }
    restore();
    is("unknown record: nothing sent, still in line, the lock let go", [blank === null || blank === "threw", sent.length, db.run(["SISMEMBER", queue, id]), db.run(["GET", `${prefix}${id}:lock`])], [true, 0, 1, null]);
    const resumed = await advance(id, async () => store, Date.now() + 10_000);
    is("the next run sends it, once", [resumed?.status, sent.flat().length], ["sent", 2]);
  }

  // Codex P on #2954 (second focal return): the send's record read back under the lock as a partial record (its id
  // with fields missing or in a shape this code never writes) is unknown: nothing is sent, it stays in line and its
  // record is not written over; a send half done goes on from where it was, so nobody gets it twice.
  part("event: the send's record read back partial under the lock");
  const half = { ...job, done: 1, sent: 1 };
  const { failures: _dropped, ...noFailures } = half;
  void _dropped;
  for (const [name, text] of [
    ["its id alone", JSON.stringify({ id })],
    ["its id with a status this code never writes", JSON.stringify({ id, status: 12 })],
    ["its id, still sending, nothing else", JSON.stringify({ id, status: "sending" })],
    ["half sent, a count missing", JSON.stringify(noFailures)],
  ] as const) {
    reset();
    db.run(["SET", "nl:cm:evmail:" + id, JSON.stringify(half)]);
    db.run(["RPUSH", "nl:cm:evmail:" + id + ":to", ...keys]);
    db.run(["SADD", "nl:cm:evmailq", id]);
    answerOnly((c) => (c[0] === "GET" && c[1] === "nl:cm:evmail:" + id ? [text] : undefined));
    let partly: unknown = "threw";
    try { partly = await advanceEventJob(id, async () => store, Date.now() + 10_000); } catch { /* checked below */ }
    restore();
    is(`${name}: nothing sent, still in line, the record as it was, the lock let go`, [partly === null || partly === "threw", sent.length, db.run(["SISMEMBER", "nl:cm:evmailq", id]), db.run(["GET", "nl:cm:evmail:" + id]), db.run(["GET", `nl:cm:evmail:${id}:lock`])], [true, 0, 1, JSON.stringify(half), null]);
    const onward = await advanceEventJob(id, async () => store, Date.now() + 10_000);
    is(`${name}: the next run sends the rest only, once`, [onward?.status, sent.flat().length], ["sent", 1]);
  }
  done();
}
void main();
