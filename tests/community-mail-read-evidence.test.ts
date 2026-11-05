import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { advanceEventJob, type EventMailJob } from "@/lib/community-event-mail";
import { commandsSeen, db, event, members, reset, sent, setReadReply, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
const keys = members.map(m => m.k);
const variants: [string, () => unknown][] = [
  ["missing envelope", () => []], ["extra envelope", () => [keys, null]],
  ["null list", () => [null]], ["empty list with readers still due", () => [[]]],
  ["truncated list", () => [[keys[0]]]], ["oversized list", () => [[...keys, "c".repeat(32)]]],
  ["duplicate readers", () => [[keys[0], keys[0]]]], ["non-string reader", () => [[keys[0], 7]]],
  ["invalid member key", () => [[keys[0], "not-a-member-key"]]],
  ["sparse list", () => [new Array(2)]],
  ["transport exception", () => { throw Error("synthetic unavailable recipient read"); }],
];
async function main(): Promise<void> {
  for (const kind of ["announcement", "event"] as const) {
    part(`${kind}: unconfirmed reader evidence must preserve progress and retry position`);
    const prefix = kind === "announcement" ? "nl:cm:mail:" : "nl:cm:evmail:";
    const queue = kind === "announcement" ? "nl:cm:mailq" : "nl:cm:evmailq";
    const advance = kind === "announcement" ? advanceAnnouncement : advanceEventJob;
    const job = { id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
      subject: "Synthetic announcement", body: "Synthetic body", event: event.id, kind: "cancelled",
      start: event.start, was: 0, wasMinutes: 0, total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
    } as AnnouncementJob & EventMailJob;
    for (const [label, reply] of variants) {
      reset();
      db.run(["SET", prefix + id, JSON.stringify(job)]);
      db.run(["RPUSH", prefix + id + ":to", ...keys]);
      db.run(["SADD", queue, id]);
      setReadReply(reply);
      let result: Awaited<ReturnType<typeof advance>> = null;
      try { result = await advance(id, async () => store, Date.now() + 10_000); } catch { /* Checked below: failures must stay visible as pending. */ }
      const saved = JSON.parse(String(db.run(["GET", prefix + id])));
      is(`${label}: no completion or invented progress`, [result?.status === "sent", saved.status === "sent", saved.done, saved.sent, sent.length], [false, false, 0, 0, 0]);
      is(`${label}: the list and pending queue survive`, [db.run(["LRANGE", prefix + id + ":to", 0, -1]), db.run(["SMEMBERS", queue])], [keys, [id]]);
      is(`${label}: visible retry note without claiming delivery`, typeof result?.note === "string" && /couldn.t.*read|could not.*read/i.test(result.note), true);
      is(`${label}: one bounded recipient read only`, commandsSeen.filter(c => c[0] === "LRANGE"), [["LRANGE", prefix + id + ":to", 0, 1]]);
      setReadReply(null);
      const resumed = await advance(id, async () => store, Date.now() + 10_000);
      is(`${label}: a confirmed reread resumes the same complete batch`, [resumed?.status, resumed?.done, resumed?.sent, sent.length, sent[0]?.length], ["sent", 2, 2, 1, 2]);
    }
    reset();
    db.run(["SET", prefix + id, JSON.stringify({ ...job, total: 3, done: 1, sent: 1 })]);
    db.run(["RPUSH", prefix + id + ":to", "c".repeat(32), ...keys]);
    db.run(["SADD", queue, id]);
    setReadReply(() => [Object.freeze([...keys])]);
    const tail = await advance(id, async () => store, Date.now() + 10_000);
    is("confirmed final short batch preserves earlier progress", [tail?.status, tail?.done, tail?.sent, sent.length], ["sent", 3, 3, 1]);
  }
  done();
}
void main();
