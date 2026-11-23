/**
 * A chart note is written only while its store is live (Codex L-20261119-1516, #5010 row 128): addNote sent an
 * unconditional HSET and EXPIRE on nl:stats:<statsId>:notes, so a note in flight while the store was erased put the
 * private notes back with a 400-day expiry. It now writes in one step with the store's fence (ADD_NOTE_IF_LIVE): a
 * store being erased or gone refuses the note and nothing is written; a live store's note is kept as before, billed at
 * ADD_NOTE_COMMANDS. Synthetic store; in-memory Redis.
 */
import { ADD_NOTE_COMMANDS, addNote, readNotes } from "@/lib/stats-notes";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, storeForEmail, storeRef, type Store } from "@/lib/store";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as notesRoute } from "@/app/api/store/notes/route";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "notes-erase@example.test";
const NOW = Date.UTC(2026, 10, 22, 12);
const DAY = "2026-11-21";

async function liveStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "noteserase", "Fictional Notes", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}
async function refused(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  part("A live store's note is kept, billed as the EVAL and its four calls");
  {
    const store = await liveStore();
    const before = redis.scriptCalls;
    const sent: (string | number)[][] = [];
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    let notes;
    try {
      notes = await addNote(store, DAY, "Posted the reel", NOW);
    } finally {
      redis.pipeline = real;
    }
    is("kept and read back", [notes?.length, (await readNotes(store.statsId))[0]?.text], [1, "Posted the reel"]);
    const write = sent.filter((c) => c[0] === "EVAL" || c[0] === "HSET" || c[0] === "EXPIRE");
    is("one EVAL, no plain HSET or EXPIRE", write.map((c) => c[0]), ["EVAL"]);
    is("its four inner calls, ADD_NOTE_COMMANDS in all", [redis.scriptCalls - before, ADD_NOTE_COMMANDS], [4, 5]);
  }

  part("A store being erased gets no note written back (Codex L-20261119-1516)");
  {
    const store = await liveStore();
    const key = `nl:stats:${store.statsId}:notes`;
    const field = await erasingField(storeRef(store));
    redis.run(["HSET", ERASING_KEY, field, String(Date.now())]);
    is("the note is refused", await refused(() => addNote(store, DAY, "Late note", NOW)), true);
    is("and no notes list is written, nor any expiry set", [Number(redis.run(["EXISTS", key])), Number(redis.run(["TTL", key]))], [0, -2]);
    redis.run(["HDEL", ERASING_KEY, field]);
    is("control: the same note once the mark is gone is kept", (await addNote(store, DAY, "Late note", NOW))?.length, 1);
  }

  part("A store whose id key is gone (the end of its erasure's walk) gets nothing written");
  {
    const store = await liveStore();
    const key = `nl:stats:${store.statsId}:notes`;
    const removed = Number(redis.run(["DEL", `nl:store:id:${store.sid}`]));
    is("the id key was there (the case is real)", removed, 1);
    is("the note is refused and nothing is kept", [await refused(() => addNote(store, DAY, "After the walk", NOW)), Number(redis.run(["EXISTS", key]))], [true, 0]);
  }

  part("The studio's whole request that adds a note stays inside the studio unit's envelope (coord 35ee)");
  {
    const store = await liveStore();
    const session = await openSession(OWNER);
    const real = redis.pipeline.bind(redis);
    const sent: (string | number)[][] = [];
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return real(commands);
    }) as typeof redis.pipeline;
    let status = 0;
    try {
      const response = await notesRoute(new NextRequest("https://marktmorgen.com/api/store/notes", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
        body: JSON.stringify({ action: "add", day: new Date().toISOString().slice(0, 10), text: "Posted the reel" }),
      }));
      status = response.status;
    } finally {
      redis.pipeline = real;
    }
    // Billed as Upstash bills a script: one, plus every redis.call inside it (an upper bound: every branch counted).
    // Padded with the whole take allowance and lockedUntil's worst case even where this fixture used less, as
    // tests/outreach-sender-erasure-fence.test.ts does.
    const billed = sent.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
    const measured = billed + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    const envelope = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    console.log("STATS_NOTE_ROUTE", JSON.stringify({ billed, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured, envelope }));
    is("the note is added (200)", [status, (await readNotes(store.statsId)).length], [200, 1]);
    is(`its billed commands, padded (${measured}), stay within the studio unit's ${envelope}`, measured <= envelope, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
