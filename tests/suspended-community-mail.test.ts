/**
 * A store switched off after notices about its content (`store.suspended`,
 * lib/takedown.ts) emails no community announcement (lib/community-mail.ts,
 * advanceAnnouncement): the send waits, nothing reserved, sent or counted as
 * done, stays in line, and goes out by itself once the store is back on. A
 * switch-off value that is neither nothing nor a day ("unknown", as
 * lib/store.ts reads it after #3399) counts as switched off (CX-123 rule 24).
 * The held run takes no command beyond the plan-off wait's: the lock, the
 * record, the community's settings and one write of the record.
 * Synthetic data only (tests/community-mail-read-world.ts).
 */
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import type { Store } from "@/lib/store";
import { commandsSeen, db, members, reserved, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const id = "e".repeat(24);
const job: AnnouncementJob = {
  id, community: store.community!.id, handle: store.handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
};
const seed = () => {
  reset();
  db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(job)]);
  db.run(["RPUSH", `nl:cm:mail:${id}:to`, ...members.map((m) => m.k)]);
  db.run(["SADD", "nl:cm:mailq", id]);
};
const saved = () => JSON.parse(String(db.run(["GET", `nl:cm:mail:${id}`]))) as AnnouncementJob;
const off = (value: string) => async (): Promise<Store> => ({ ...store, suspended: value });

async function main(): Promise<void> {
  part("Control: a store that is on sends the announcement");
  seed();
  const healthy = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
  is("sent to both members, once, and out of line", [healthy?.status, healthy?.sent, sent.length, db.run(["SISMEMBER", "nl:cm:mailq", id])], ["sent", 2, 1, 0]);

  for (const [label, value] of [["Switched off on a day", "2026-11-09T12:00:00.000Z"], ["A switch-off value in no known shape (rule 24)", "unknown"]] as const) {
    part(label);
    seed();
    const held = await advanceAnnouncement(id, off(value), Date.now() + 10_000);
    is("nothing sent, nothing reserved", [sent.length, reserved.length], [0, 0]);
    is("it waits, nothing done or counted as sent", [held?.status, held?.done, held?.sent, saved().status, saved().done], ["waiting", 0, 0, "waiting", 0]);
    is("it says why, and that it goes out once the store is back on", [/switched off/.test(saved().note), /back on/.test(saved().note)], [true, true]);
    is("it stays in line, its list whole", [db.run(["SISMEMBER", "nl:cm:mailq", id]), db.run(["LLEN", `nl:cm:mail:${id}:to`])], [1, 2]);
    is("no list read, no member read: the lock, the record and one write", commandsSeen.some((c) => c[0] === "LRANGE"), false);

    part(`${label}, then back on`);
    const resumed = await advanceAnnouncement(id, async () => store, Date.now() + 10_000);
    is("it goes out by itself, to both members, once", [resumed?.status, resumed?.sent, sent.length, db.run(["SISMEMBER", "nl:cm:mailq", id])], ["sent", 2, 1, 0]);
  }

  done();
}

void main();
