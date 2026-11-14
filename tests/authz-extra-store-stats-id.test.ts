/**
 * Authorization sweep (claude7/authz-hunt): six studio routes (notes, person,
 * goal, spend, short-links, chat-summary) gave a store with no statsId one
 * by calling ensureStatsId(store.email). An owner's extra store is kept under
 * its own ref ("#<sid>"), never under the owner's email, so for an extra
 * store that call read, and wrote into, the owner's FIRST store instead: a
 * note, a goal or a person's note meant for store B landed on store A, which
 * a teammate of B may have no role on. The other routes call
 * ensureStatsId(guarded.ref); these now do the same. Stores made today
 * always get a statsId, so the test takes it off store B's record by hand,
 * as a store written before visits were counted has none. Synthetic stores,
 * in-memory Redis, no network.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, createStore, ensureStatsId, storeForEmail, storeForId, storeRef } from "@/lib/store";
import { readNotes } from "@/lib/stats-notes";
import { PIN_HEADER } from "@/lib/studio-route";
import { POST as notes } from "@/app/api/store/notes/route";
import { store as redis } from "@/tests/redis-stub";
import { done, is, part } from "@/tests/check";

const OWNER = "authz-extra-stats@example.com";

globalThis.fetch = async () => {
  throw new Error("External fetch forbidden");
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "authzfirststore", "First store", "");
  const first = await ensureStatsId(OWNER);
  const made = await createStore(OWNER, "authzextrastore", "Extra store", "");
  if (!made.ok || !first?.statsId) throw new Error(`setup failed: ${JSON.stringify(made)}`);
  const extra = made.store;
  is("the extra store is kept under its own ref", storeRef(extra), `#${extra.sid}`);

  // A record written before visits were counted: no statsId.
  let stripped = 0;
  for (const key of redis.keys().filter((name) => name.startsWith("nl:store:owner:"))) {
    const [raw] = (await redis.pipeline([["GET", key]])) as unknown[];
    if (typeof raw !== "string" || !raw.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.sid !== extra.sid || record.handle !== "authzextrastore") continue;
    await redis.pipeline([["SET", key, JSON.stringify({ ...record, statsId: null })]]);
    stripped += 1;
  }
  is("the extra store's record had its statsId taken off", stripped, 1);
  is("and reads back without one", (await storeForId(extra.sid))?.statsId ?? null, null);

  part("a note added on the extra store lands on the extra store");
  const session = await openSession(OWNER);
  const response = await notes(
    new NextRequest("https://marktmorgen.com/api/store/notes", {
      method: "POST",
      headers: {
        host: "marktmorgen.com",
        origin: "https://marktmorgen.com",
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${session}`,
        [PIN_HEADER]: extra.sid,
      },
      body: JSON.stringify({ action: "add", day: new Date().toISOString().slice(0, 10), text: "Meant for the extra store" }),
    }),
  );
  is("the note is taken", response.status, 200);
  is("nothing was written on the owner's first store", (await readNotes(first.statsId)).length, 0);
  const after = await storeForId(extra.sid);
  is("the extra store now has a statsId of its own", Boolean(after?.statsId) && after?.statsId !== first.statsId, true);
  is("and the note is on it", after?.statsId ? (await readNotes(after.statsId)).map((note) => note.text) : [], ["Meant for the extra store"]);
  is("the first store keeps its own statsId", (await storeForEmail(OWNER))?.statsId, first.statsId);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
