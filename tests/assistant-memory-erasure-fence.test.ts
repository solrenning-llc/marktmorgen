/**
 * Codex P-20261120-0045 (#5010 row 44): a note saved through the real studio route, paused just before its write's
 * EVAL, must not write the store's notes back once the store's erasure began (its erasing mark) or ended (its keys
 * gone). The change holds only the notes' own lock, which the erasure's walk does not take, so a late write would
 * leave the creator's notes under the erased statsId with no expiry. A store with an id and one from before ids
 * (legacy), whose owner may open a new store under the same address meanwhile, and a store with an id whose account
 * moved and began erasing under the new ref (store-claim-live:v1). The live control still saves; a store moved and
 * live under its new ref gets back the room the change took. And the route changes notes only through the fenced
 * writers, never the bare ones.
 * Synthetic: the Redis stand-in only.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/assistant-memory/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ERASING_KEY, type Store, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { skipWaits } from "./skip-waits";
skipWaits(["takeLock", "paced"]);

const EMAIL = "memory-erasure@example.invalid";
const NOTE = "Write in a warm, plain voice.";

/** The id key of the store kept under the owner's address now, if it has one. */
async function ownerIdKey(): Promise<string | null> {
  const raw = redis.run(["GET", await ownerKey(EMAIL)]);
  const sid = typeof raw === "string" ? (JSON.parse(raw) as { sid?: string }).sid : "";
  return sid ? storeIdCommand(sid)[1] : null;
}

/** Makes the store kept under the owner's address one from before ids: no id in its record, no id key. */
async function makeLegacy(): Promise<void> {
  const idKey = await ownerIdKey();
  if (idKey) redis.run(["DEL", idKey]);
  const kept = JSON.parse(String(redis.run(["GET", await ownerKey(EMAIL)]))) as Store;
  redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: "" })]);
}

/** Posts `body` to the real route, running `step` once just before the notes' write EVAL. */
async function postWith(body: Record<string, unknown>, step: () => Promise<void>): Promise<{ status: number; json: Record<string, unknown>; reached: boolean }> {
  const session = await openSession(EMAIL);
  const original = redis.pipeline;
  let reached = false;
  redis.pipeline = async (commands) => {
    if (!reached && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:amem-write"))) {
      reached = true;
      await step();
    }
    return original.call(redis, commands);
  };
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/assistant-memory", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
      body: JSON.stringify(body),
    }));
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, reached };
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  for (const kind of ["primary", "legacy"] as const) for (const state of ["live", "gone", "erasing", "reopened", "moved", "moved-live"] as const) {
    if (kind === "primary" && state === "reopened") continue;
    // A store from before ids has no id key to repoint: the move is a store with an id's case.
    if (kind === "legacy" && (state === "moved" || state === "moved-live")) continue;
    const label = `${kind}/${state}`;
    part(label);
    redis.clear();
    await claimHandle(EMAIL, "memory-erasure", "Synthetic", "");
    await ensureStatsId(EMAIL);
    await ensureStoreId(EMAIL);
    await setSubscription(EMAIL, { customerId: "cus_memoryErasure", subscriptionId: "sub_memoryErasure", active: true, tier: "creator", period: paidPeriod() });
    if (kind === "legacy") await makeLegacy();
    const real = (await storeForEmail(EMAIL))!;
    if (kind === "legacy") is(label + " starts from a store with no id", real.sid, "");
    const ref = storeRef(real);
    const key = `nl:amem:${real.statsId}`;
    const room = dataKey(real)!;

    const sent = await postWith({ action: "add", kind: "preference", text: NOTE }, async () => {
      if (state === "gone" || state === "reopened") {
        // The erasure's record step: the store's own keys go (its id key, if it has one, and its record), then the walk's.
        const idKey = await ownerIdKey();
        if (idKey) redis.run(["DEL", idKey]);
        redis.run(["DEL", await ownerKey(EMAIL)]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
      if (state === "reopened") {
        // The owner opens a new store under the same address: the same owner key, another statsId.
        const kept = JSON.parse(JSON.stringify(real)) as Store;
        redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: "", statsId: "0123456789abcdef0123456789abcdef" })]);
      }
      if (state === "moved") {
        // moveAccount repoints the id key to the new ref, and an erasure begun after the move marks the new ref's field.
        const idKey = await ownerIdKey();
        if (!idKey) throw new Error("no id key");
        const moved = "memory-erasure-moved@example.invalid";
        redis.run(["SET", idKey, moved]);
        redis.run(["HSET", ERASING_KEY, await erasingField(moved), "1"]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
      if (state === "moved-live") {
        // moveAccount repointed the id key and nothing is being erased: the store is live under its new ref, and its
        // room (keyed by its sid, which the move keeps) is still its own.
        const idKey = await ownerIdKey();
        if (!idKey) throw new Error("no id key");
        redis.run(["SET", idKey, "memory-erasure-moved@example.invalid"]);
      }
      if (state === "erasing") {
        redis.run(["HSET", ERASING_KEY, await erasingField(ref), "1"]);
        redis.run(["DEL", key]);
        redis.run(["DEL", room]);
      }
    });
    is(label + " reached the notes' write", sent.reached, true);
    if (state === "live") {
      is(label + " a live store still saves", [sent.status, sent.json.ok], [200, true]);
      is(label + " and its note is kept", JSON.parse(String(redis.run(["GET", key]))).map((n: { text: string }) => n.text), [NOTE]);
      continue;
    }
    is(label + " answers that the store is gone (410), not saved", [sent.status, sent.json.ok, sent.json.error], [410, false, "gone"]);
    is(label + " does not write the erased store's notes back", redis.run(["GET", key]), null);
    if (state === "moved-live") {
      // The live store's room keeps no weight for notes that were never written: it is given back.
      const fields = redis.run(["HGETALL", room]) as string[];
      const slot = fields.findIndex((f, i) => i % 2 === 0 && f === "amem");
      is(label + " gives the notes' room back to the live store", slot === -1 || Number(fields[slot + 1]) === 0, true);
      continue;
    }
    is(label + " nor its data room", redis.run(["EXISTS", room]), 0);
  }

  part("The stand-in answers as the Lua does, and counts its inner calls (Claude 6 018ZjhH's LEVE on #5112)");
  {
    const { MEMORY_WRITE_LIVE } = await import("@/lib/assistant-memory-store");
    const run = async (record: string | null, statsId: string) => {
      redis.clear();
      redis.run(["SET", "t:lock", "tok"]);
      if (record !== null) redis.run(["SET", "t:live", record]);
      const before = redis.scriptCalls;
      const [answer] = await redis.pipeline([["EVAL", MEMORY_WRITE_LIVE, 4, "t:lock", "t:notes", "t:live", "t:erasing", "tok", "[1]", "f", statsId, "r"]]);
      return { answer, calls: redis.scriptCalls - before, notes: redis.run(["GET", "t:notes"]) };
    };
    // cjson decodes a JSON array to a table too, so its statsId is nil: another store (-4), never unreadable (-3).
    is("an owner record that is a JSON array is another store (-4), as in Redis", (await run("[1,2]", "s1")).answer, -4);
    is("an owner record that is not JSON is unreadable (-3)", (await run("not json", "s1")).answer, -3);
    is("an owner record that is a JSON number is unreadable (-3)", (await run("7", "s1")).answer, -3);
    const kept = await run(JSON.stringify({ statsId: "s1" }), "s1");
    is("a live store from before ids writes, with its 4 inner calls (GET, HGET, GET, SET)", [kept.answer, kept.calls, kept.notes], [1, 4, "[1]"]);
    is("a store with an id that moved: 3 inner calls, nothing written", await run("r2", ""), { answer: -5, calls: 3, notes: null });
  }

  part("The route changes notes only through the fenced writers");
  const source = readFileSync("app/api/store/assistant-memory/route.ts", "utf8");
  for (const bare of ["keepNote", "changeNote", "dropNote"]) is(`never the bare ${bare}`, new RegExp(`\\b${bare}\\(`).test(source), false);
  for (const fenced of ["keepStoreNote", "changeStoreNote", "dropStoreNote"]) is(`through ${fenced}`, new RegExp(`\\b${fenced}\\(`).test(source), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
