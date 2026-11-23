/**
 * Existing funnel-share POST regression. No proposed exports imported here.
 * Synthetic real store/session/source funnel, existing route and Redis stand-in.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, moveAccount, storeForEmail, storeRef } from "@/lib/store";
import { readPageFunnels } from "@/lib/page-funnel-store";
import { openShare } from "@/lib/funnel-share-store";
import { POST } from "@/app/api/store/funnel-share/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "share-erasure@example.com";
const NAME = "Alice Example";
globalThis.fetch = async () => { throw new Error("External fetch forbidden"); };
async function fixture() {
  redis.clear();
  await claimHandle(OWNER, "shareerasure", NAME, "");
  await ensureStatsId(OWNER);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const send = (body: Record<string, unknown>) => POST(new NextRequest("https://marktmorgen.com/api/store/funnel-share", {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
  // Same real setup path as funnel-share-counted-stage.test.ts.
  const imported = await send({ action: "import", starter: "coaching-application", products: {} });
  if (imported.status !== 200) throw new Error("synthetic source import failed");
  const parent = await storeForEmail(OWNER);
  if (!parent?.statsId) throw new Error("setup");
  const funnel = (await readPageFunnels(parent.statsId))[0];
  if (!funnel) throw new Error("source funnel missing");
  return { parent, send, funnel, list: `nl:fshares:${parent.statsId}` };
}
async function main(): Promise<void> {
  for (const state of ["closed", "erasing"] as const) {
    part(state);
    const f = await fixture();
    const original = redis.pipeline;
    let hits = 0, lookup = "";
    redis.pipeline = async (commands) => {
      const first = commands[0];
      if (hits || commands.length !== 1 || first?.[0] !== "EVAL" ||
          first[3] !== f.list || !String(first[4]).startsWith("nl:fshare:")) return original.call(redis, commands);
      hits++;
      lookup = String(first[4]);
      // The prepared snapshot has not yet been written. The walk passed this
      // list while it was empty; the delayed creation must not put it back.
      if (state === "closed") {
        is("real parent close completed", await closeStoreRecord(f.parent, [f.list, lookup]), true);
      } else {
        await original.call(redis, [["DEL", f.list, lookup], ["HSET", ERASING_KEY, await erasingField(storeRef(f.parent)), "synthetic-walk"]]);
      }
      return original.call(redis, commands);
    };
    let response: Response;
    try { response = await f.send({ action: "share", funnel: f.funnel.id, days: 365 }); }
    finally { redis.pipeline = original; }
    const body = await response.json() as { ok?: boolean; code?: string; error?: string };
    is("intercepted actual final snapshot creation", hits, 1);
    is("no list or lookup recreated", await redis.pipeline([["EXISTS", f.list], ["EXISTS", lookup]]), [0, 0]);
    is("confirmed gone store is reported, never a new link", [response.status, body.error, !!body.code], [410, "gone", false]);
    if (body.code) is("an old response's code cannot expose the erased sender", await openShare(body.code, "bundle"), null);
    // On main both keys are created, HTTP is 200 and openShare returns a
    // record with from === NAME. No new-export import failure is called RED.
  }
  // Codex L-20261121-0043: a completed account move changes the value of the store's id key (the owner ref) while its
  // sid and statsId stay. A share request admitted under the old ref must not pass the fence after the move: when the
  // erasure then starts at the NEW ref, the old ref's erasing field is absent and the id key still exists.
  for (const state of ["moved-live", "moved-erasing"] as const) {
    part(state);
    const f = await fixture();
    const movedOwner = "share-moved@example.test";
    const original = redis.pipeline.bind(redis);
    let hits = 0, lookup = "";
    let moved: Awaited<ReturnType<typeof storeForEmail>> = null;
    redis.pipeline = async commands => {
      const c = commands[0];
      if (!hits && commands.length === 1 && c?.[0] === "EVAL" && c[3] === f.list && String(c[4]).startsWith("nl:fshare:")) {
        hits++;
        lookup = String(c[4]);
        const changed = await moveAccount(OWNER, movedOwner);
        is("the real account move completed before the stale share write", changed.ok, true);
        moved = await storeForEmail(movedOwner);
        if (!changed.ok || !moved || moved.sid !== f.parent.sid || moved.statsId !== f.parent.statsId) throw new Error("move fixture did not preserve store identity");
        if (state === "moved-erasing") {
          // The walk at the NEW ref passed the empty share family. The old request still carries the old ref.
          await original([["DEL", f.list, lookup], ["HSET", ERASING_KEY, await erasingField(storeRef(moved)), String(Date.now())]]);
          is("the old ref has no erasing field", (await original([["HGET", ERASING_KEY, await erasingField(storeRef(f.parent))]]))[0], null);
        }
      }
      return original(commands);
    };
    let response: Response;
    try { response = await f.send({ action: "share", funnel: f.funnel.id, days: 365 }); }
    finally { redis.pipeline = original; }
    const body = await response.json() as { error?: string; code?: string };
    is("the real final share write was intercepted once", hits, 1);
    is("the stale owner scope never returns a share code", [response.status, body.error, Boolean(body.code)], [410, "gone", false]);
    if (state === "moved-erasing") {
      if (!moved) throw new Error("no moved store");
      is("the real moved store close completed", await closeStoreRecord(moved, [f.list]), true);
      is("the list and public snapshot do not survive the final close", await original([["EXISTS", f.list], ["EXISTS", lookup]]), [0, 0]);
      const privatePayload = (await original([["HMGET", lookup, "rec", "bundle"]]))[0];
      is("the erased sender is not retained inside the orphan snapshot", JSON.stringify(privatePayload).includes(NAME), false);
      if (body.code) is("a stale response cannot open the erased sender's snapshot", await openShare(body.code, "bundle"), null);
    } else {
      // A fresh request under the new owner's real session still makes a live share.
      const cookie = `${SESSION_COOKIE}=${await openSession(movedOwner)}`;
      const fresh = await POST(new NextRequest("https://marktmorgen.com/api/store/funnel-share", {
        method: "POST", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "share", funnel: f.funnel.id, days: 365 }),
      }));
      const freshBody = await fresh.json() as { ok?: boolean; code?: string };
      is("the moved live store still shares in its current scope", [fresh.status, freshBody.ok, Boolean(freshBody.code)], [200, true, true]);
    }
  }
  part("live control");
  const f = await fixture();
  const response = await f.send({ action: "share", funnel: f.funnel.id, days: 365 });
  const body = await response.json() as { ok?: boolean; code?: string };
  is("ordinary creation succeeds", [response.status, body.ok], [200, true]);
  if (!body.code) throw new Error("live share code missing");
  const opened = await openShare(body.code, "bundle");
  is("same intended sender while parent is live", opened?.from, NAME);
  const list = await redis.pipeline([["HGETALL", f.list]]);
  const meta = JSON.parse((list[0] as string[])[1]) as { hash: string };
  const ttl = (await redis.pipeline([["TTL", `nl:fshare:${meta.hash}`]]))[0] as number;
  is("chosen retention stays 365 days (within one minute)", ttl > 365 * 86400 - 60 && ttl <= 365 * 86400, true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
