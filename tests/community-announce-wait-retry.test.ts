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

  // The coordinator's cost line (ibqho c2c2): how many sends a community can have held at once has a ceiling, and the
  // commands of each run and each hourly look are held to the constants the company exposure line counts.
  const MOST: unknown = (communityMail as Record<string, unknown>).ANNOUNCEMENTS_HELD_MOST;
  const RUN: unknown = (communityMail as Record<string, unknown>).ANNOUNCEMENT_HELD_RUN_COMMANDS;
  const LOOK_OWN: unknown = (communityMail as Record<string, unknown>).ANNOUNCEMENT_HELD_LOOK_OWN_COMMANDS;
  is("at most 3 sends of a community are held at once", MOST, 3);
  part("A fourth send held for the same community ends at once, saying why");
  {
    reset();
    shift = 0;
    const off = { ...store, suspended: "2026-11-09T12:00:00.000Z" } as Store;
    const ids = ["1", "2", "3", "4"].map((d) => d.repeat(24));
    for (const one of ids) {
      db.run(["SET", `nl:cm:mail:${one}`, JSON.stringify({ ...job, id: one })]);
      db.run(["RPUSH", `nl:cm:mail:${one}:to`, ...members.map((m) => m.k)]);
      db.run(["SADD", "nl:cm:mailq", one]);
    }
    const answers = [];
    for (const one of ids) answers.push(await advanceAnnouncement(one, async () => off, Date.now() + 10_000));
    is("the first three wait", answers.slice(0, 3).map((a) => a?.status), ["waiting", "waiting", "waiting"]);
    is("the fourth ends, out of line, nothing sent", [answers[3]?.status, db.run(["SISMEMBER", "nl:cm:mailq", ids[3]]), sent.length], ["failed", 0, 0]);
    is("saying that only 3 wait at a time", /3 announcements/.test(answers[3]?.note ?? ""), true);
    commandsSeen.length = 0;
    await advanceAnnouncement(ids[0], async () => off, Date.now() + 10_000);
    is(`a run while held sends at most ANNOUNCEMENT_HELD_RUN_COMMANDS (${String(RUN)}) commands`, typeof RUN === "number" && commandsSeen.length <= RUN, true);
    shift = 3_600_000 + 1_000;
    commandsSeen.length = 0;
    await advanceAnnouncement(ids[0], async () => off, Date.now() + 10_000);
    is(`an hourly look sends at most ANNOUNCEMENT_HELD_LOOK_OWN_COMMANDS (${String(LOOK_OWN)}) of its own, besides the store's and the settings' reads`, typeof LOOK_OWN === "number" && commandsSeen.length <= LOOK_OWN, true);
    shift = 0;
    // Back on, the first goes out, and a new send can be held again in its place.
    shift = 2 * 3_600_000;
    const resumed = await advanceAnnouncement(ids[1], async () => store, Date.now() + 10_000);
    is("back on, a held send goes out", resumed?.status, "sent");
  }

  // Claude 7 xAF's MEDIUM on #5341: the place among the held sends is taken in one atomic step, so sends held at the
  // same moment never pass the ceiling together.
  part("Five sends held at the same moment: three wait, two end");
  {
    reset();
    shift = 0;
    const off = { ...store, suspended: "2026-11-09T12:00:00.000Z" } as Store;
    const ids = ["5", "6", "7", "8", "9"].map((d) => d.repeat(24));
    for (const one of ids) {
      db.run(["SET", `nl:cm:mail:${one}`, JSON.stringify({ ...job, id: one })]);
      db.run(["RPUSH", `nl:cm:mail:${one}:to`, ...members.map((m) => m.k)]);
      db.run(["SADD", "nl:cm:mailq", one]);
    }
    const all = await Promise.all(ids.map((one) => advanceAnnouncement(one, async () => off, Date.now() + 10_000)));
    is("exactly three wait, the others end", [all.filter((a) => a?.status === "waiting").length, all.filter((a) => a?.status === "failed").length], [3, 2]);
  }

  // Claude 7 xAF's LEVE on #5341: a held set that does not read still starts the send's 60 days.
  // Claude 2 upbeat's LEVE on #5341 @2ce39a47c7: a send whose place could not be taken must never wait outside the
  // ceiling, look after look. The set's read only lets go of places of sends that ended; the place is taken by the
  // atomic script whether that read answers or not, and a send whose place is not known to be taken ends at once.
  const offStore = { ...store, suspended: "2026-11-09T12:00:00.000Z" } as Store;
  const seedSends = (ids: string[]) => {
    reset();
    for (const one of ids) {
      db.run(["SET", `nl:cm:mail:${one}`, JSON.stringify({ ...job, id: one })]);
      db.run(["RPUSH", `nl:cm:mail:${one}:to`, ...members.map((m) => m.k)]);
      db.run(["SADD", "nl:cm:mailq", one]);
    }
  };
  const realPipeline = db.pipeline.bind(db);
  const bend = (when: (commands: (string | number)[][]) => boolean) => {
    db.pipeline = (async (commands: (string | number)[][]) => (when(commands) ? [7] : realPipeline(commands))) as typeof db.pipeline;
  };
  const heldSet = `nl:cm:mailq:held:${job.community}`;

  part("A held set that never reads: the place is still taken atomically, and the ceiling of 3 holds");
  {
    shift = 0;
    const ids = ["a", "b", "c", "d", "e", "f", "0"].map((d) => d.repeat(24));
    seedSends(ids);
    bend((commands) => commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).startsWith("nl:cm:mailq:held:"));
    const all: (AnnouncementJob | null)[] = [];
    for (const one of ids) all.push(await advanceAnnouncement(one, async () => offStore, Date.now() + 10_000));
    db.pipeline = realPipeline;
    is("three wait with a place, the others end: never more than 3 held", [all.filter((a) => a?.status === "waiting").length, all.filter((a) => a?.status === "failed").length, Number(db.run(["SCARD", heldSet]))], [3, 4, 3]);
    is("each one waiting holds its place, its 60 days started", all.filter((a) => a?.status === "waiting").every((a) => a?.heldPlaced === true && typeof a?.heldSince === "number"), true);
  }

  part("The place's own answer does not read: the send ends at once, never held outside the ceiling");
  {
    shift = 0;
    seedSends([id]);
    bend((commands) => commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:announcement-hold:v1"));
    const ended = await advanceAnnouncement(id, async () => offStore, Date.now() + 10_000);
    db.pipeline = realPipeline;
    is("it ends, out of line, nothing sent", [ended?.status, db.run(["SISMEMBER", "nl:cm:mailq", id]), sent.length], ["failed", 0, 0]);
    is("saying it could not be held", /could not be held/.test(ended?.note ?? ""), true);
  }
  Date.now = realNow;
  done();
}

void main();
