/**
 * One community announcement that throws never holds up the others (lib/community-mail.ts, advanceAnnouncements). The
 * mail job walked the queue and let the first throw end the walk, so an announcement that failed every time kept every
 * announcement after it from going out, run after run. Now each runs on its own: a throw is logged and counted on its
 * own record (failures, status "waiting" with a note); the others go out in the same run; after
 * ANNOUNCEMENT_ERRORS_MOST in a row it is stopped as failed, says so, and leaves the queue. Synthetic data only
 * (tests/community-mail-read-world.ts).
 */
import { ANNOUNCEMENT_ERRORS_MOST, advanceAnnouncements, type AnnouncementJob } from "@/lib/community-mail";
import type { Store } from "@/lib/store";
import { db, members, reset, sent, store } from "./community-mail-read-world";
import { done, is, part } from "./check";

const broken = "a".repeat(24);
const healthy = "b".repeat(24);
const jobOf = (id: string, handle: string): AnnouncementJob => ({
  id, community: store.community!.id, handle, post: "f".repeat(12),
  subject: "Synthetic announcement", body: "Synthetic body", total: 2, done: 0, sent: 0, status: "sending", note: "", failures: 0,
});
const read = (id: string) => JSON.parse(String(db.run(["GET", `nl:cm:mail:${id}`]))) as AnnouncementJob;
/** The broken announcement's store throws when it is loaded; the healthy one's loads. */
const load = async (handle: string): Promise<Store | null> => {
  if (handle === "broken") throw new Error("synthetic failure loading a store");
  return store;
};

async function main(): Promise<void> {
  reset();
  for (const [id, handle] of [[broken, "broken"], [healthy, store.handle]] as const) {
    db.run(["SET", `nl:cm:mail:${id}`, JSON.stringify(jobOf(id, handle))]);
    db.run(["RPUSH", `nl:cm:mail:${id}:to`, ...members.map((m) => m.k)]);
    db.run(["SADD", "nl:cm:mailq", id]);
  }
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };

  part("One announcement that throws does not stop the others");
  let threw = false;
  try {
    await advanceAnnouncements(load, Date.now() + 10_000);
  } catch {
    threw = true;
  }
  is("the run does not throw", threw, false);
  is("the healthy announcement went out", [read(healthy).status, sent.length], ["sent", 1]);
  is("the broken one waits, counted once, saying so", [read(broken).status, read(broken).failures, /tried again/.test(read(broken).note)], ["waiting", 1, true]);
  is("and stays in line", db.run(["SISMEMBER", "nl:cm:mailq", broken]), 1);
  is("the error is logged, never hidden", errors.some((args) => String(args[0]).includes("announcement failed")), true);

  part(`After ${ANNOUNCEMENT_ERRORS_MOST} in a row it is stopped as failed`);
  for (let run = 1; run < ANNOUNCEMENT_ERRORS_MOST; run += 1) await advanceAnnouncements(load, Date.now() + 10_000);
  is("failed, with the reason, out of line", [read(broken).status, read(broken).failures, /stopped/.test(read(broken).note), db.run(["SISMEMBER", "nl:cm:mailq", broken])], ["failed", ANNOUNCEMENT_ERRORS_MOST, true, 0]);
  console.error = original;
  done();
}

void main();
