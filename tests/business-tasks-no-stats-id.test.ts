/**
 * MÉDIO of the review at 65207788cc on #3562: a store written before visits were counted has no statsId, and the
 * Tasks block showed "No tasks yet." with the Add form while every add answered 503 "could not be read", for good.
 * The real route on the in-memory Redis with a synthetic store and a real session: the first change gives the store
 * its statsId (ensureStatsId, as app/api/store/crm/route.ts does) and the task is kept and read back.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/business-tasks/route";
import { claimHandle, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const URL_ = "https://marktmorgen.com/api/store/business-tasks";

async function main(): Promise<void> {
  redis.clear();
  const owner = "tasks-no-stats@example.com";
  await claimHandle(owner, "tasks-no-stats", "Tasks Check", "");
  // A store written before visits were counted: its record has no statsId (lib/store.ts, nl:store:owner:<hash>).
  const key = `nl:store:owner:${createHash("sha256").update(`nimbus-store:${owner}`).digest("hex").slice(0, 40)}`;
  const [raw] = await redis.pipeline([["GET", key]]);
  const record = JSON.parse(String(raw)) as Record<string, unknown>;
  delete record.statsId;
  await redis.pipeline([["SET", key, JSON.stringify(record)]]);
  part("A store with no statsId");
  is("it has none (the case under test)", (await storeForEmail(owner))?.statsId ?? null, null);
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = (body: Record<string, unknown>) =>
    POST(new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));

  const added = await post({ action: "add", title: "First task", due: "" });
  const data = (await added.json()) as { ok?: boolean; tasks?: { title: string }[] };
  is("the first add is kept, not answered 503", [added.status, data.ok, data.tasks?.map((t) => t.title)], [200, true, ["First task"]]);
  is("the store now has a statsId", typeof (await storeForEmail(owner))?.statsId, "string");
  const read = await GET(new NextRequest(URL_, { headers: { cookie } }));
  const listed = (await read.json()) as { ok?: boolean; tasks?: { title: string }[] };
  is("and it reads back", [read.status, listed.tasks?.map((t) => t.title)], [200, ["First task"]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
