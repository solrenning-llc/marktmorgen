/** Independent worker evidence. Only the existing synthetic dependencies are substituted. */
import test from "node:test";
import assert from "node:assert/strict";
import { advanceAnnouncement } from "@/lib/community-mail";
import { advanceEventJob } from "@/lib/community-event-mail";
import { commandsSeen, db, event, members, reset, sent, setReadReply, store } from "./community-mail-read-world";

const id = "e".repeat(24);
const keys = members.map(m => m.k);
const kinds = ["announcement", "24", "1", "moved", "cancelled"] as const;
for (const kind of kinds) {
  const announcement = kind === "announcement";
  const prefix = announcement ? "nl:cm:mail:" : "nl:cm:evmail:";
  const queue = announcement ? "nl:cm:mailq" : "nl:cm:evmailq";
  const advance = announcement ? advanceAnnouncement : advanceEventJob;
  function seed() {
    reset();
    db.run(["SET", prefix + id, JSON.stringify({ id, community: store.community!.id,
      handle: store.handle, post: "f".repeat(12), subject: "Synthetic review", body: "Synthetic body",
      event: event.id, kind, start: event.start, was: event.start - 86400000, wasMinutes: 30,
      total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0 })]);
    db.run(["RPUSH", prefix + id + ":to", ...keys]);
    db.run(["SADD", queue, id]);
  }
  for (const variant of ["outer accessor", "inner accessor", "outer extra", "inner extra", "inherited slot"] as const) {
    test(kind + " rejects " + variant + " before delivery and resumes unchanged", async () => {
      seed();
      let reads = 0;
      const rows = [...keys];
      const outer = [rows];
      if (variant === "outer accessor") Object.defineProperty(outer, "0", { get() { reads++; return rows; } });
      if (variant === "inner accessor") Object.defineProperty(rows, "1", { get() { reads++; return keys[1]; } });
      if (variant === "outer extra") Object.defineProperty(outer, "extra", { get() { reads++; return 1; } });
      if (variant === "inner extra") Object.defineProperty(rows, "extra", { get() { reads++; return 1; } });
      if (variant === "inherited slot") { delete rows[1]; Object.setPrototypeOf(rows, Object.assign(Object.create(Array.prototype), { 1: keys[1] })); }
      setReadReply(() => outer);
      const pending = await advance(id, async () => store, Date.now() + 10000);
      assert.ok(pending);
      assert.equal(pending.status === "sent", false);
      assert.deepEqual([pending.done, pending.sent, sent.length, reads], [0, 0, 0, 0]);
      assert.match(pending.note, /couldn't read/);
      assert.deepEqual(db.run(["SMEMBERS", queue]), [id]);
      assert.deepEqual(db.run(["LRANGE", prefix + id + ":to", 0, -1]), keys);
      assert.deepEqual(commandsSeen.filter(c => c[0] === "LRANGE"), [["LRANGE", prefix + id + ":to", 0, 1]]);
      setReadReply(null);
      const complete = await advance(id, async () => store, Date.now() + 10000);
      assert.deepEqual([complete?.status, complete?.done, complete?.sent, sent.length], ["sent", 2, 2, 1]);
      assert.deepEqual(db.run(["SMEMBERS", queue]), []);
    });
  }
  test(kind + " accepts a frozen exact envelope without extra recipient commands", async () => {
    seed();
    setReadReply(() => Object.freeze([Object.freeze([...keys])]));
    const result = await advance(id, async () => store, Date.now() + 10000);
    assert.deepEqual([result?.status, result?.done, result?.sent, sent.length], ["sent", 2, 2, 1]);
    assert.deepEqual(commandsSeen.filter(c => c[0] === "LRANGE"), [["LRANGE", prefix + id + ":to", 0, 1]]);
  });
}
