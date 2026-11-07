import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import { advanceEventJob, type EventMailJob } from "@/lib/community-event-mail";
import { commandsSeen, db, event, members, released, reset, sent, setReadReply, setTokenWriteFails, store } from "./community-mail-read-world";
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
    part(`${kind}: an unread later batch must keep the confirmed earlier batch`);
    reset();
    const size = kind === "announcement" ? 25 : 100;
    const firstKeys = [keys[0], ...Array.from({ length: size - 1 }, (_, i) => i.toString(16).padStart(32, "0"))];
    db.run(["SET", prefix + id, JSON.stringify({ ...job, total: size + 1 })]);
    db.run(["RPUSH", prefix + id + ":to", ...firstKeys, keys[1]]);
    db.run(["SADD", queue, id]);
    setReadReply(() => {
      const command = commandsSeen.at(-1)!;
      return command[2] === 0 ? [db.run(command)] : [];
    });
    const partial = await advance(id, async () => store, Date.now() + 10_000);
    is("later unread batch preserves confirmed progress only", [partial?.status === "sent", partial?.done, partial?.sent, sent.length], [false, size, 1, 1]);
    is("later unread batch preserves the complete original list", db.run(["LRANGE", prefix + id + ":to", 0, -1]), [...firstKeys, keys[1]]);
    setReadReply(null);
    const afterPartial = await advance(id, async () => store, Date.now() + 10_000);
    is("retry resumes at the later batch and never resends the first", [afterPartial?.status, afterPartial?.done, afterPartial?.sent, sent.map(messages => messages.length)], ["sent", size + 1, 2, [1, 1]]);
    reset();
    members.forEach(member => { member.removed = true; });
    db.run(["SET", prefix + id, JSON.stringify(job)]);
    db.run(["RPUSH", prefix + id + ":to", ...keys]);
    db.run(["SADD", queue, id]);
    const removed = await advance(id, async () => store, Date.now() + 10_000);
    is("confirmed readers who were removed are skipped without being emailed", [removed?.status, removed?.done, removed?.sent, sent.length], ["sent", 2, 0, 0]);
    members.forEach(member => { member.removed = false; });
    reset();
    db.run(["SET", prefix + id, JSON.stringify({ ...job, total: 3, done: 1, sent: 1 })]);
    db.run(["RPUSH", prefix + id + ":to", "c".repeat(32), ...keys]);
    db.run(["SADD", queue, id]);
    setReadReply(() => [Object.freeze([...keys])]);
    const tail = await advance(id, async () => store, Date.now() + 10_000);
    is("confirmed final short batch preserves earlier progress", [tail?.status, tail?.done, tail?.sent, sent.length], ["sent", 3, 3, 1]);
  }
  part("announcement: a stop link that could not be kept is never sent, and the send stays pending");
  {
    reset();
    const job = { id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
      subject: "Synthetic announcement", body: "Synthetic body", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
    } as AnnouncementJob;
    db.run(["SET", "nl:cm:mail:" + id, JSON.stringify(job)]);
    db.run(["RPUSH", "nl:cm:mail:" + id + ":to", ...keys]);
    db.run(["SADD", "nl:cm:mailq", id]);
    const kept = members[0].t;
    members[0].t = "";
    setTokenWriteFails(true);
    let result: Awaited<ReturnType<typeof advanceAnnouncement>> | "thrown" = null;
    try { result = await advanceAnnouncement(id, async () => store, Date.now() + 10_000); } catch { result = "thrown"; }
    const saved = JSON.parse(String(db.run(["GET", "nl:cm:mail:" + id])));
    is("nothing sent, no progress, the reservation given back", [sent.length, saved.done, saved.sent, released], [0, 0, 0, [2]]);
    is("said as still pending, never thrown out of the mail job", result !== "thrown" && [result?.status, /couldn.t save/i.test(result?.note ?? "")], ["waiting", true]);
    is("the list and the pending queue survive", [db.run(["LRANGE", "nl:cm:mail:" + id + ":to", 0, -1]), db.run(["SMEMBERS", "nl:cm:mailq"])], [keys, [id]]);
    setTokenWriteFails(false);
    const resumed = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
    is("once the token is kept, the same batch goes out", [resumed?.status, resumed?.sent, sent.length], ["sent", 2, 1]);
    members[0].t = kept;
  }
  done();
}
void main();
