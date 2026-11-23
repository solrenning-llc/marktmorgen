/**
 * Board #5285, row #3406: Claude 1's MEDIUM 1 and LOW of 6760353197. A community announcement held for a store
 * switched off after notices (`store.suspended`), or for a plan without email, was looked at again on every run of
 * /api/cron/mail (every 5 minutes): the lock, the record, the store, the community's settings and a write of the
 * record, for as long as the hold lasted, with no ceiling (about 8,640 looks a month for each). It now waits an hour
 * between looks (ANNOUNCEMENT_RETRY_SECONDS, as broadcasts' LIST_RETRY_SECONDS): until then a run reads only the lock
 * and the record, never the store, and writes nothing. Once the hour is past and the store is back on, it goes out by
 * itself, as before. Synthetic data only (tests/community-mail-read-world.ts).
 */
import * as communityMail from "@/lib/community-mail";
import { advanceAnnouncement, type AnnouncementJob } from "@/lib/community-mail";
import type { Store } from "@/lib/store";
import { commandsSeen, db, members, reset, sent, store } from "./community-mail-read-world";
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
/** Read off the module, so the test runs (and fails) on a main that does not have it yet. */
const RETRY: unknown = (communityMail as Record<string, unknown>).ANNOUNCEMENT_RETRY_SECONDS;
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

async function main(): Promise<void> {
  is("the wait between looks is an hour, as a broadcast's", RETRY, 3_600);
  for (const [label, held] of [
    ["Switched off after notices", { ...store, suspended: "2026-11-09T12:00:00.000Z" } as Store],
    ["A plan without email", { ...store, mail: undefined } as unknown as Store],
  ] as const) {
    part(label);
    seed();
    shift = 0;
    let loads = 0;
    const load = (value: Store) => async () => {
      loads += 1;
      return value;
    };
    const first = await advanceAnnouncement(id, load(held), Date.now() + 10_000);
    is("control: it waits, nothing sent", [first?.status, sent.length], ["waiting", 0]);
    commandsSeen.length = 0;
    loads = 0;
    const again = await advanceAnnouncement(id, load(held), Date.now() + 10_000);
    is("a run five minutes later does not read the store", loads, 0);
    is("and writes nothing: no SET of the record", commandsSeen.some((c) => c[0] === "SET" && c[1] === `nl:cm:mail:${id}`), false);
    is("it still waits, in line", [again?.status, db.run(["SISMEMBER", "nl:cm:mailq", id])], ["waiting", 1]);
    shift = 30 * 60_000;
    loads = 0;
    await advanceAnnouncement(id, load(store), Date.now() + 10_000);
    is("half an hour on, back on or not, it is not looked at yet", [loads, sent.length], [0, 0]);
    shift = 3_600_000 + 1_000;
    const resumed = await advanceAnnouncement(id, load(store), Date.now() + 10_000);
    is("an hour on, back on: it goes out by itself, to both members, once", [resumed?.status, resumed?.sent, sent.length, db.run(["SISMEMBER", "nl:cm:mailq", id])], ["sent", 2, 1, 0]);
  }

  // Claude 4 AC (2aab): a held send still has an end. Kept ANNOUNCEMENT_HELD_DAYS (60, as a product update held on a
  // switched-off store), then it ends, out of line, saying so: never looked at once an hour for good.
  const HELD_DAYS: unknown = (communityMail as Record<string, unknown>).ANNOUNCEMENT_HELD_DAYS;
  is("a held send is kept 60 days, as a held product update", HELD_DAYS, 60);
  for (const [label, held, why] of [
    ["Switched off after notices, for good", { ...store, suspended: "2026-11-09T12:00:00.000Z" } as Store, /switched off/],
    ["A plan without email, for good", { ...store, mail: undefined } as unknown as Store, /email/],
  ] as const) {
    part(label);
    seed();
    shift = 0;
    await advanceAnnouncement(id, async () => held, Date.now() + 10_000);
    shift = 59 * 86_400_000;
    const day59 = await advanceAnnouncement(id, async () => held, Date.now() + 10_000);
    is("on day 59 it still waits, in line", [day59?.status, db.run(["SISMEMBER", "nl:cm:mailq", id])], ["waiting", 1]);
    shift = 60 * 86_400_000 + 3_600_000;
    const ended = await advanceAnnouncement(id, async () => held, Date.now() + 10_000);
    is("past 60 days it ends, out of line, nothing sent", [ended?.status, db.run(["SISMEMBER", "nl:cm:mailq", id]), sent.length], ["failed", 0, 0]);
    is("saying why and that it waited 60 days", [why.test(ended?.note ?? ""), /60 days/.test(ended?.note ?? "")], [true, true]);
  }
  Date.now = realNow;
  done();
}

void main();
