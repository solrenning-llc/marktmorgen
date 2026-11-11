/**
 * A closing store whose owner moves its sign-in address is still erased, record and all (Claude 6's probes P6 and
 * P7 on #3643, comment 6786348742).
 *
 * Everything that sees a closing store through is keyed by the home store's ref, which is its owner's address: its
 * place in the line of ended plans (ENDED_INDEX), in the final line (FINAL_INDEX), in the walk's line (DUE_KEY), its
 * closing state, and its folder's holds, paid periods, notices and credit (lib/plan-closing.ts, lib/closing-*.ts).
 * moveAccount (lib/store.ts) gave the store a new ref and left all of those on the old one. The walk then read the old
 * key as nil and dropped the store (`stores: 0`), and the daily closing run read it as "gone" and took it out of every
 * line; the moved record (its id, name and the new address) stayed at the new address and was never erased. Only the
 * billing sync's daily scan put the new ref back in the line of ended plans, where its closing started over from
 * nothing, its folder's holds and paid periods left behind.
 *
 * A store in its closing (its plan ended on or after KEEP_NOTHING_FROM and does not run, or it is in the final line
 * or the walk's line) now keeps its address until it is erased or its plan runs again: the move is refused,
 * read under the store's own lock, and a line that does not read is never "not closing" (rule 24).
 *
 * Synthetic stores, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as moveRoute } from "@/app/api/auth/move/route";
import { POST as callback } from "@/app/api/auth/callback/route";
import { BATCH_KEY, DUE_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { KEEP_NOTHING_FROM } from "@/lib/plan-closing-rules";
import { type MoveResult, claimHandle, ensureStatsId, ensureStoreId, moveAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ownerKey = (email: string) => "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + email).digest("hex").slice(0, 40);
const idKey = (sid: string) => `nl:store:id:${sid}`;
const handleKey = (handle: string) => `nl:store:handle:${handle}`;

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const ORIGIN = "https://marktmorgen.com";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");
const form = (url: string, fields: Record<string, string>, cookie = "") =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
/** A session opened by the emailed sign-in link, as tests/second-step-gate.test.ts opens one. */
async function linkSession(email: string): Promise<string> {
  const token = hex(String(Math.random()));
  await redis.pipeline([["SET", `nl:auth:link:${hex(`nimbus-auth-link:${token}`).slice(0, 40)}`, email, "EX", 900]]);
  const response = await callback(form(`${ORIGIN}/api/auth/callback`, { token }));
  return (response.headers.get("set-cookie") ?? "").match(/nl_session=([^;]*)/)?.[1] ?? "";
}

/** Runs once, the moment the walk writes its entry for a store (prepareStore, after its first read of the record). */
let onBatchWrite: ((ref: string) => Promise<void>) | null = null;
/** The two reads of a store's closing lines answered in a shape Redis never gives. */
let linesUnread = false;
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (onBatchWrite && commands.length === 1 && commands[0][0] === "HSET" && commands[0][1] === BATCH_KEY) {
    const hook = onBatchWrite;
    onBatchWrite = null;
    await hook(String(commands[0][2]));
  }
  if (linesUnread && commands.length && commands.every((c) => c[0] === "ZSCORE") && commands.some((c) => c[1] === FINAL_INDEX)) return [{}];
  return realPipeline(commands);
};

async function makeStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

/** A store whose plan ended now (after KEEP_NOTHING_FROM: it closes). */
async function endedStore(email: string, handle: string) {
  await makeStore(email, handle);
  await setSubscription(email, { active: true, customerId: "cus_moved0001", subscriptionId: "sub_moved0001", tier: "creator" });
  await setSubscription(email, { active: false });
  const store = await storeForEmail(email);
  if (!store || !(Date.parse(store.planEndedAt) >= KEEP_NOTHING_FROM)) throw new Error(`setup: ${handle} has no ended plan`);
  return store;
}

/** Its closing day has run (lib/plan-closing.ts closingDay): in the final line and in line for the walk. */
async function pastItsDay(email: string, endedAt: number, at: number) {
  redis.run(["ZADD", FINAL_INDEX, endedAt, email]);
  await markDue(email, at);
}

/** A whole walk: its stores prepared, the database walked and the stores finished. */
async function walk(now: number) {
  const first = await eraseClosed(Date.now() + 30_000, async () => {}, now);
  let report = first;
  for (let run = 0; run < 5 && !report.done; run += 1) report = await eraseClosed(Date.now() + 30_000, async () => {}, now);
  return { stores: first.stores, done: report.done };
}

/** Where the store's record is, by address, and whether its id and its address still lead anywhere. */
function traces(from: string, to: string, sid: string, handle: string) {
  return {
    atOld: redis.run(["GET", ownerKey(from)]) !== null,
    atNew: redis.run(["GET", ownerKey(to)]) !== null,
    id: redis.run(["GET", idKey(sid)]),
    handle: String(redis.run(["GET", handleKey(handle)]) ?? "").startsWith("released:") ? "released" : redis.run(["GET", handleKey(handle)]),
  };
}

const refused = { ok: false, reason: "closing" };
/** A move's answer, without the moved record. */
const outcome = (result: MoveResult | string) => (typeof result === "string" ? result : result.ok ? { ok: true } : { ok: false, reason: result.reason });

async function main(): Promise<void> {
  redis.clear();
  {
    const probe = await makeStore("probe@example.com", "probeone");
    if (redis.run(["GET", ownerKey("probe@example.com")]) === null) throw new Error("setup: the owner key formula does not match lib/store.ts");
    if (redis.run(["GET", idKey(probe.sid)]) === null) throw new Error("setup: the store id key formula does not match lib/store.ts");
    if (redis.run(["GET", handleKey("probeone")]) === null) throw new Error("setup: the handle key formula does not match lib/store.ts");
  }

  part("P7: a closing store whose owner moves address before its walk is erased, record and all");
  redis.clear();
  const A = "closing-a@example.com";
  const A2 = "closing-a-new@example.com";
  const a = await endedStore(A, "closinga");
  const TA = Date.now();
  await pastItsDay(A, Date.parse(a.planEndedAt), TA - 1000);
  const movedA = await moveAccount(A, A2);
  is("the move is refused while the store closes", outcome(movedA), refused);
  is("before the walk, the record is still at the address its closing knows", [traces(A, A2, a.sid, a.handle).atOld, traces(A, A2, a.sid, a.handle).atNew], [true, false]);
  const walkedA = await walk(TA);
  is("the walk takes the store, and finishes", [walkedA.stores, walkedA.done], [1, true]);
  is("its record is gone, at the old address and the new one; its id names nothing; its address is held back", traces(A, A2, a.sid, a.handle), { atOld: false, atNew: false, id: null, handle: "released" });
  is("nothing is left in any line", [redis.run(["ZSCORE", DUE_KEY, A]), redis.run(["ZSCORE", DUE_KEY, A2]), redis.run(["ZSCORE", FINAL_INDEX, A2]), redis.run(["ZSCORE", ENDED_INDEX, A2])], [null, null, null, null]);

  part("P6: the move comes in the window between the walk's first read of the record and its deletion");
  redis.clear();
  const E = "closing-e@example.com";
  const E2 = "closing-e-new@example.com";
  const e = await endedStore(E, "closinge");
  const TE = Date.now();
  await pastItsDay(E, Date.parse(e.planEndedAt), TE - 1000);
  let inWindow: MoveResult | string = "not reached";
  onBatchWrite = async (ref) => {
    if (ref === E) inWindow = await moveAccount(E, E2);
  };
  const walkedE = await walk(TE);
  onBatchWrite = null;
  is("the move in the window is refused", outcome(inWindow), refused);
  is("the walk takes the store, and finishes", [walkedE.stores, walkedE.done], [1, true]);
  is("its record is gone, at both addresses; its id names nothing; its address is held back", traces(E, E2, e.sid, e.handle), { atOld: false, atNew: false, id: null, handle: "released" });

  part("Before its closing day: a store whose plan ended keeps its address while it closes");
  redis.clear();
  const B = "ended-b@example.com";
  const b = await endedStore(B, "endedb");
  is("in the line of ended plans under its address", redis.run(["ZSCORE", ENDED_INDEX, B]) !== null, true);
  is("the move is refused", outcome(await moveAccount(B, "ended-b-new@example.com")), refused);
  is("the record and its place in line stay where they were", [traces(B, "ended-b-new@example.com", b.sid, b.handle).atOld, traces(B, "ended-b-new@example.com", b.sid, b.handle).atNew, redis.run(["ZSCORE", ENDED_INDEX, B]) !== null], [true, false, true]);
  is("control: once its plan runs again, it moves", (await setSubscription(B, { active: true }), (await moveAccount(B, "ended-b-new@example.com")).ok), true);

  part("A store seen through whatever its plan does since (the final line, or the walk's line) keeps its address");
  for (const [what, put] of [
    ["the final line", (ref: string) => void redis.run(["ZADD", FINAL_INDEX, Date.now() - 1000, ref])],
    ["the walk's line", (ref: string) => void redis.run(["ZADD", DUE_KEY, Date.now() - 1000, ref])],
  ] as const) {
    redis.clear();
    const C = "lined-c@example.com";
    const c = await makeStore(C, "linedc");
    put(C);
    is(`a store with no plan running, in ${what}: the move is refused`, outcome(await moveAccount(C, "lined-c-new@example.com")), refused);
    is(`in ${what}: the record stays at its address`, [traces(C, "lined-c-new@example.com", c.sid, c.handle).atOld, traces(C, "lined-c-new@example.com", c.sid, c.handle).atNew], [true, false]);
  }

  part("Rule 24: a closing line that does not read is never \"not closing\"");
  redis.clear();
  const H = "unread-h@example.com";
  const h = await makeStore(H, "unreadh");
  linesUnread = true;
  let threw = "";
  try {
    await moveAccount(H, "unread-h-new@example.com");
  } catch (error) {
    threw = (error as Error).name;
  } finally {
    linesUnread = false;
  }
  is("the move throws an unknown reply", threw, "UnknownReplyError");
  is("nothing moved", [traces(H, "unread-h-new@example.com", h.sid, h.handle).atOld, traces(H, "unread-h-new@example.com", h.sid, h.handle).atNew, redis.run(["GET", idKey(h.sid)])], [true, false, H]);

  part("The route: tapping a move link for a closing store says so, and nothing moves");
  redis.clear();
  const R = "route-r@example.com";
  const R2 = "route-r-new@example.com";
  const r = await endedStore(R, "router");
  const session = await linkSession(R);
  // A move link (written here as lib/auth.ts sendMoveLink writes one): the tap is refused under the store's lock, and
  // the ways in that moved first are put back (app/api/auth/move, undo).
  const token = hex("closing-moved-owner-link");
  await redis.pipeline([["SET", `nl:auth:move:${hex(`nimbus-auth-move:${token}`).slice(0, 40)}`, JSON.stringify({ from: R, to: R2, session }), "EX", 900]]);
  const tapped = await moveRoute(form(`${ORIGIN}/api/auth/move`, { token }));
  is("tapped: refused, and said so on the sign-in page", tapped.headers.get("location"), `${ORIGIN}/signin?status=move-closing`);
  is("tapped: the store stays at its address", [traces(R, R2, r.sid, r.handle).atOld, traces(R, R2, r.sid, r.handle).atNew, redis.run(["GET", idKey(r.sid)])], [true, false, R]);

  part("Controls: a store that is not closing moves as before");
  redis.clear();
  const F = "open-f@example.com";
  const f = await makeStore(F, "openf");
  const movedF = await moveAccount(F, "open-f-new@example.com");
  is("a store with no plan moves", [movedF.ok, traces(F, "open-f-new@example.com", f.sid, f.handle)], [true, { atOld: false, atNew: true, id: "open-f-new@example.com", handle: "open-f-new@example.com" }]);
  const G = "kept-g@example.com";
  const g = await endedStore(G, "keptg");
  // A plan that ended before KEEP_NOTHING_FROM keeps its room with no date on it and never closes: it moves.
  const raw = JSON.parse(String(redis.run(["GET", ownerKey(G)])));
  redis.run(["SET", ownerKey(G), JSON.stringify({ ...raw, planEndedAt: new Date(KEEP_NOTHING_FROM - 86_400_000).toISOString() })]);
  const movedG = await moveAccount(G, "kept-g-new@example.com");
  is("a store whose plan ended before 18 October 2026 moves", [movedG.ok, traces(G, "kept-g-new@example.com", g.sid, g.handle).atNew], [true, true]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
