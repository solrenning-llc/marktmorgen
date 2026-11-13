/**
 * Issue #4264: a locked session (lib/two-step.ts openLockedSession, let in without the second step) may not
 * delete anything for good under "products" (LOCKED_ACTIONS.products, C2-76). /api/store/call took
 * `{ id, remove: true }` with no `action`, so guardStoreWrite asked lockedOut("products", "") and let it through:
 * the call's whole setup (hours, dated sessions and their meeting links, place) and its team of hosts were deleted.
 * Editing a call stays open to a locked session; only turning it back into a product waits.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductCall, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { readProduct } from "@/lib/catalog";
import { openLockedSession } from "@/lib/two-step";
import { POST as call } from "@/app/api/store/call/route";
import { POST as callTeam } from "@/app/api/store/call-team/route";
import { writeTeam } from "@/lib/team-booking";
import type { TeamSetup } from "@/lib/team-scheduling-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "call.locked@example.com";
const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
const post = (session: string, body: unknown, path = "call") =>
  new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) });
const answer = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? ""];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "calllocked", "Call Locked", "");
  await ensureStatsId(OWNER);
  const made = await addProduct(OWNER, "Coaching", "", "45", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const saved = await setProductCall(OWNER, id, weekly as unknown as CallSetup);
  if (!(saved as { ok: boolean }).ok) throw new Error("no call");
  const full = await openSession(OWNER);
  const locked = await openLockedSession(OWNER, Date.now() + 7 * 86_400_000);
  const room = async () => (await readProduct((await storeForEmail(OWNER))!, id))?.call?.room ?? null;

  // Second review on #4412: /api/store/call-team took `{ id, team: null }` with no `action` either, and HDELed the
  // call's team of hosts (with the createdAt that decides teamOrder).
  const callsId = (await storeForEmail(OWNER))!.callsId;
  is("(control) the store has a calls id once the call is set", typeof callsId, "string");
  const teamKey = `nl:callteam:${callsId}`;
  await writeTeam({ callsId }, id, { synthetic: "team of hosts", createdAt: 1 } as unknown as TeamSetup);
  const team = () => redis.run(["HGET", teamKey, id]);
  part("A locked session deleting the call's team of hosts");
  is("is refused as locked", await answer(await callTeam(post(locked, { id, team: null }, "call-team"))), [403, "locked"]);
  is("and the team is still there", typeof team(), "string");

  part("A locked session turning a call back into a product");
  is("is refused as locked", await answer(await call(post(locked, { id, remove: true }))), [403, "locked"]);
  is("and the call's setup is still there", await room(), "https://example.com/room");

  part("A locked session editing the call");
  is("is not refused", (await answer(await call(post(locked, { id, call: { ...weekly, room: "https://example.com/other" } }))))[1] !== "locked", true);

  part("The full session deleting the call's team of hosts");
  is("is let through", (await answer(await callTeam(post(full, { id, team: null }, "call-team"))))[0], 200);
  is("and the team is gone", team(), null);

  part("The full session turning the call back into a product");
  is("is let through", await answer(await call(post(full, { id, remove: true }))), [200, ""]);
  is("and the product is no longer a call", await room(), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
