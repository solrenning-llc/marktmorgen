/**
 * Issue #4393 (Codex L, reproduced by Claude 2): the course page authorises a visit and defers the student's
 * attendance write (after()); an erasure of that student completes in between. The deferred write must not bring the
 * row back, and gives back the room it took; a student who was not deleted is written as before. Synthetic records.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { makeWorld, seedPerson } from "./erasure-world";
import { ROOM } from "./data-room";
import { erasePerson } from "@/lib/person-erasure";
import { emailKey, touchStudent } from "@/lib/learn";
import { redisPipeline } from "@/lib/redis";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const w = await makeWorld();
  await seedPerson(w, "tess-4393@example.com", null);
  await seedPerson(w, "sam-4393@example.com", null);
  const row = async (e: string) => (await redisPipeline([["HGET", `nl:course:${w.courseId}:students`, emailKey(e)]]))[0];
  const now = Math.floor(Date.now() / 1000);
  const erased = { listId: w.store.listId };

  part("A visit authorised before an erasure, written after it, brings nothing back (issue #4393)");
  is("the store has a list to check", typeof w.store.listId, "string");
  is("the erasure completes", (await erasePerson(w.store, "tess-4393@example.com", { kind: "person" })).ok, true);
  is("the row is gone after it", await row("tess-4393@example.com"), null);
  await touchStudent(w.courseId, "tess-4393@example.com", now - 100, w.store, erased);
  is("the deferred write leaves the erased student's row absent", await row("tess-4393@example.com"), null);

  part("A student who was not deleted is written as before");
  await touchStudent(w.courseId, "sam-4393@example.com", now - 100, w.store, erased);
  is("their row is there", typeof (await row("sam-4393@example.com")), "string");

  part("A store with no list cannot be checked: nothing is written");
  await touchStudent(w.courseId, "nolist-4393@example.com", now - 100, ROOM, { listId: null });
  is("no row", await row("nolist-4393@example.com"), null);

  done();
}

void main();
