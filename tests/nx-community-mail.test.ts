/**
 * A community send's claims read exactly (CX-123 rule 24, lib/claim-mark.ts): the lock that lets one run move an
 * announcement or an event email on, and the mark that makes a move, cancellation or reminder once. "OK", or our own
 * value read back, is ours; nil is another run's; anything else is unknown, and nothing is sent, reset or let go on it.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { advanceEventJob, queueEventNotice, runEventQueue, type EventMailJob } from "@/lib/community-event-mail";
import { db, event, members, reset, sent, store } from "./community-mail-read-world";
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
  done();
}
void main();
