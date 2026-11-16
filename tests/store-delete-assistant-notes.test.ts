/**
 * An extra store deleted from the studio (app/api/store/stores) forgets its
 * assistant's notes (lib/assistant-memory-store.ts forgetMemory) with the rest
 * of what it kept. A forgetting that is not confirmed never leaves the notes
 * behind as "deleted": the store goes in the forget line (lib/store-forget-retry.ts)
 * and the daily try removes them. Their room in the store's data room (which
 * outlives the store) is given back once, only when the deletion is confirmed. Decision of Claude 1, 05/11/2026 16h31 (item 5b).
 * Synthetic only, through the real POST route.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, createStore, ensureStatsId, storeForId } from "@/lib/store";
import { keepNote, readMemoryState } from "@/lib/assistant-memory-store";
import { dataKey } from "@/lib/store-data";
import { retryStoreForgets } from "@/lib/store-forget-retry";
import { POST as storesRoute } from "@/app/api/store/stores/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

async function extraWithNotes(owner: string, first: string, extra: string) {
  await claimHandle(owner, first, `${first} store`, "");
  await ensureStatsId(owner);
  const made = await createStore(owner, extra, `${extra} store`, "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  const store = (await storeForId(made.store.sid))!;
  const statsId = store.statsId;
  if (!statsId) throw new Error("the extra store has no stats id");
  const withId = { ...store, statsId };
  for (const text of ["Always answer in a warm tone.", "Mention the free shipping over $50."]) {
    const kept = await keepNote(statsId, { kind: "instruction", text }, withId);
    if (!("ok" in kept) || !kept.ok) throw new Error(`note not kept: ${JSON.stringify(kept)}`);
  }
  return { sid: made.store.sid, statsId, store: withId };
}

async function deleteFromStudio(owner: string, handle: string, sid: string) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("action", "delete");
  form.set("confirm", handle);
  return storesRoute(new NextRequest("https://marktmorgen.com/api/store/stores", { method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": sid }, body: form }));
}

const notesKey = (statsId: string) => `nl:amem:${statsId}`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("An extra store deleted from the studio forgets its assistant's notes");
  {
    const OWNER = "notes-owner@example.com";
    const { sid, statsId, store } = await extraWithNotes(OWNER, "notesfirst", "notesextra");
    const before = await readMemoryState(statsId);
    is("before: the extra store's assistant keeps two notes", before.ok ? before.notes.length : "unreadable", 2);
    const room = dataKey(store)!;
    const notesRoom = () => Number(redis.run(["HGET", room, "amem"]) ?? 0);
    is("before: the notes take room in the store's data room", notesRoom() > 0, true);
    const response = await deleteFromStudio(OWNER, "notesextra", sid);
    is("the studio's delete answers by going back to the studio", [response.status, response.headers.get("Location")?.includes("stores=deleted")], [303, true]);
    is("after: no note of the deleted store is kept", redis.run(["EXISTS", notesKey(statsId)]), 0);
    is("nothing is left in the forget line: the forgetting was confirmed", redis.run(["HLEN", "nl:forget:q"]), 0);
    is("their room is given back once, exactly: the data room counts no notes, and never less than none", notesRoom(), 0);
  }

  part("A forgetting of the notes that is not confirmed goes in the line, and the daily try removes them");
  {
    const OWNER = "notes-retry@example.com";
    const { sid, statsId, store } = await extraWithNotes(OWNER, "retryfirst", "retryextra");
    const room = dataKey(store)!;
    const notesRoom = () => Number(redis.run(["HGET", room, "amem"]) ?? 0);
    const counted = notesRoom();
    // The notes' own deletion script answers in an unknown shape: the notes are still there, and nothing says so.
    redis.pipeline = async (commands: Command[]) => {
      if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:amem-forget:")) return [[]];
      return real(commands);
    };
    const response = await deleteFromStudio(OWNER, "retryextra", sid);
    redis.pipeline = real;
    is("the store is still deleted for its owner", [response.status, response.headers.get("Location")?.includes("stores=deleted")], [303, true]);
    is("its notes are still there after the unconfirmed forgetting", redis.run(["EXISTS", notesKey(statsId)]), 1);
    const line = redis.run(["HKEYS", "nl:forget:q"]) as string[];
    is("the store is put in the forget line, never counted as forgotten", line, [`${statsId}|${sid}`]);
    const tried = await retryStoreForgets(Date.now() + 30_000);
    is("the daily try finishes it", [tried.done, tried.failed], [1, 0]);
    is("after the daily try: no note is kept", redis.run(["EXISTS", notesKey(statsId)]), 0);
    is("and the line is empty", redis.run(["HLEN", "nl:forget:q"]), 0);
    is("until then their room stayed counted (nothing was confirmed gone)", counted > 0, true);
    is("after the try their room is given back once, exactly", notesRoom(), 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
