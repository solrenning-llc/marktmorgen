/**
 * Existing funnel-share POST regression. No proposed exports imported here.
 * Synthetic real store/session/source funnel, existing route and Redis stand-in.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, storeForEmail, storeRef } from "@/lib/store";
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
