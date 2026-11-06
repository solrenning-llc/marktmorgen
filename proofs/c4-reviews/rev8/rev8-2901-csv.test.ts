/** Proof: listAsCsv (lib/free.ts) swallows the new UnknownReplyError from allValues, and the creator's list file holds every CRM answer blank, with no error. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listAsCsv } from "@/lib/free";
import { personKey } from "@/lib/person-key";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const STATS = "synthetic-crm-csv";
const LIST = "synthetic-list-csv";
const FIELD = { id: "plan01", name: "Plan", type: "text", options: [] };
const store = { statsId: STATS, listId: LIST } as unknown as Store;

async function seed() {
  redis.clear();
  await redis.pipeline([
    ["SET", `nl:crm:fields:${STATS}`, JSON.stringify([FIELD])],
    ["HSET", `nl:crm:v:${STATS}:${FIELD.id}`, personKey(STATS, "ana@example.com"), "Gold"],
    ["HSET", `nl:store:leads:${LIST}`, "ana@example.com", JSON.stringify({ agreed: true, firstAt: "2026-01-01", lastAt: "2026-01-01", titles: [] })],
  ]);
}

test("control: Ana's answer is in the file", async () => {
  await seed();
  const csv = await listAsCsv(store, false);
  assert.match(csv.split("\r\n")[1], /,"Gold"$/);
});

test("an unknown CRM values reply fails the file, never writes every answer blank", async () => {
  await seed();
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands[0][0] === "HGETALL" ? [{ unexpected: "shape" }] : original.call(redis, commands)) as typeof redis.pipeline;
  let out: string | Error;
  try { out = await listAsCsv(store, false); } catch (e) { out = e as Error; } finally { redis.pipeline = original; }
  console.log("# result:", JSON.stringify(typeof out === "string" ? out : String(out)));
  assert.ok(out instanceof Error, "the file was produced with Ana's 'Gold' missing");
});
