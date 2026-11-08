/**
 * Giving a discount code to an affiliate, and taking it back, read only in their exact shape (CX-123 rules 24 and 30;
 * audit R24 round 8, finding 2). Synthetic only: the in-memory Redis double, through the real lib/affiliate-codes.ts
 * and the real route app/api/store/affiliates/route.ts.
 *
 * giveCode wrote `nl:aff:<id>:promo` with HSET and returned true without reading the reply, so the route answered
 * `{ ok: true }` and the creator saw the code given. When the HSET reply came in another shape and nothing was
 * written, codeOwners still held the previous affiliate: a code moved from Ana to Ben kept crediting Ana's sales
 * (writeReferral writes once, with HSETNX). Now an HSET reply that is not a count of 0 or 1 throws UnknownReplyError,
 * and the route answers 503 "unavailable", never ok. The HEXISTS before it, which decides whether the code takes
 * room in the store's data room, is read exactly too: an unknown reply writes nothing and takes no room.
 *
 * Rule 30: takeCodeBack read its HGET and HDEL replies with Number(...), so an unknown HDEL reply read as "nothing
 * removed" ("unknown" to the creator, the room kept although the code may be gone). Now an unknown reply throws
 * (503 "unavailable"); a confirmed 0 is still "not held" and a confirmed 1 still gives back the room.
 *
 * Controls: a new code (HSET 1) and a move (HSET 0) are given as before, a new code takes room once, a move none.
 */
import { NextRequest } from "next/server";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { codeOwners, giveCode, takeCodeBack } from "@/lib/affiliate-codes";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "codes@example.com";
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const PROMO = "promo_1TestGiveCode0001";
const FRESH = "promo_1TestGiveCode0002";

/**
 * Which command on the codes hash answers in an unknown shape, whether it ran first, and the reply. The HEXISTS and
 * the HSET of a give are one script since Claude 2's MEDIUM on #3300 (GIVE_CODE, KEYS[2] the codes hash), so either
 * breaks that script's reply.
 */
type Break = { command: "HSET" | "HEXISTS" | "HDEL"; ran: boolean; reply: () => unknown } | null;
let breakWhat: Break = null;
const real = redis.pipeline.bind(redis);
const gives = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:affiliate-code-give:v1\n") && /^nl:aff:[^:]+:promo$/.test(String(c[4]));
redis.pipeline = (async (commands: (string | number)[][]) => {
  const hit = breakWhat && commands.some((c) => (breakWhat!.command !== "HDEL" && gives(c)) || (c[0] === breakWhat!.command && /^nl:aff:[^:]+:promo$/.test(String(c[1]))));
  if (hit && breakWhat) {
    if (breakWhat.ran) await real(commands);
    return breakWhat.reply();
  }
  return real(commands);
}) as typeof redis.pipeline;

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return `returned ${String(value)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: Date.now() - 30 * 86_400_000, decidedAt: 1, note: "" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "codeshop", "Code Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiveCodeXX", true);
  await setSubscription(OWNER, { customerId: "cus_codeshop", subscriptionId: "sub_codeshop", active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
  ]);
  const session = await openSession(OWNER);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const owner = async (promo: string) => (await codeOwners(store)).get(promo) ?? "";
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("Control: a new code is given (HSET 1), takes room once, and the route says ok");
  const before = await used();
  is("a new code is given to Ana", await giveCode(store, PROMO, ANA), true);
  is("the code is Ana's", await owner(PROMO), ANA);
  const afterNew = await used();
  is("a new code takes room in the data room", afterNew > before, true);

  // Each unknown shape the HSET could answer while nothing was written. One field set can only count 0 or 1.
  const shapes: [string, unknown][] = [
    ["OK", ["OK"]],
    ["QUEUED", ["QUEUED"]],
    ["a lost reply", [undefined]],
    ["null", [null]],
    ["no reply at all", []],
    ["a numeric string", ["1"]],
    ["a negative", [-1]],
    ["a fraction", [0.5]],
    ["two for one field", [2]],
    ["an object", [{}]],
    ["two replies for one command", [0, 0]],
    ["a move receipt with a total", [[2, 240]]],
    ["a room that could not be read", [[-1, 0]]],
    ["a receipt with an extra item", [[1, 240, 0]]],
    ["a receipt with a text total", [[1, "240"]]],
  ];

  part("Moving the code from Ana to Ben: an unknown HSET reply is never 'given'");
  for (const [name, reply] of shapes) {
    breakWhat = { command: "HSET", ran: false, reply: () => reply };
    is(`${name}: giveCode throws UnknownReplyError instead of returning true`, await thrown(() => giveCode(store, PROMO, BEN)), "UnknownReplyError");
    const answer = await post({ action: "code", promo: PROMO, id: BEN });
    is(`${name}: the route does not answer ok`, [answer.status, answer.body.ok, answer.body.error], [503, false, "unavailable"]);
    breakWhat = null;
    is(`${name}: the code is still Ana's, as the creator is told it was not moved`, await owner(PROMO), ANA);
    is(`${name}: a code already held takes no more room`, await used(), afterNew);
  }

  part("A reply in an unknown shape after the write did run is still not 'given'");
  breakWhat = { command: "HSET", ran: true, reply: () => ["QUEUED"] };
  is("written, then QUEUED: giveCode throws", await thrown(() => giveCode(store, PROMO, BEN)), "UnknownReplyError");
  breakWhat = null;
  is("(the write had run: the code is Ben's; the creator was told to try again, not that it failed for good)", await owner(PROMO), BEN);
  is("moving it back to Ana (HSET 0) is given as before", await giveCode(store, PROMO, ANA), true);
  is("the code is Ana's again", await owner(PROMO), ANA);

  part("The HEXISTS that decides the room is read exactly: unknown writes nothing and takes no room");
  for (const [name, reply] of [["OK", ["OK"]], ["a numeric string", ["0"]], ["a lost reply", [undefined]], ["no reply", []], ["two", [2]], ["two replies", [0, 0]]] as [string, unknown][]) {
    breakWhat = { command: "HEXISTS", ran: false, reply: () => reply };
    is(`${name}: giving a fresh code throws`, await thrown(() => giveCode(store, FRESH, BEN)), "UnknownReplyError");
    breakWhat = null;
    is(`${name}: the fresh code was not written`, await owner(FRESH), "");
    is(`${name}: no room was taken`, await used(), afterNew);
  }

  part("Control: the move through the route is ok, the code becomes Ben's, and takes no room");
  const moved = await post({ action: "code", promo: PROMO, id: BEN });
  is("the route answers ok on a healthy move", [moved.status, moved.body.ok], [200, true]);
  is("the code is Ben's", await owner(PROMO), BEN);
  is("a move takes no room", await used(), afterNew);

  part("Rule 30: taking a code back reads HGET and HDEL exactly");
  for (const [name, reply] of [["OK for HDEL", [BEN, "OK"]], ["a lost HDEL", [BEN, undefined]], ["a numeric string", [BEN, "1"]], ["two removed", [BEN, 2]], ["a number for HGET", [5, 1]], ["one reply for two", [BEN]], ["no reply", []]] as [string, unknown][]) {
    breakWhat = { command: "HDEL", ran: false, reply: () => reply };
    is(`${name}: takeCodeBack throws instead of saying 'not held'`, await thrown(() => takeCodeBack(store, PROMO)), "UnknownReplyError");
    breakWhat = null;
    is(`${name}: the code is still Ben's`, await owner(PROMO), BEN);
    is(`${name}: no room was given back`, await used(), afterNew);
  }
  breakWhat = { command: "HDEL", ran: false, reply: () => [BEN, "OK"] };
  const unknownBack = await post({ action: "code", promo: PROMO, id: "" });
  breakWhat = null;
  is("an unknown take-back through the route answers 503 'unavailable', not 'unknown'", [unknownBack.status, unknownBack.body.ok, unknownBack.body.error], [503, false, "unavailable"]);

  part("Control: a healthy take-back gives the room back; a code not held is still 'not held'");
  const back = await post({ action: "code", promo: PROMO, id: "" });
  is("the route answers ok on a healthy take-back", [back.status, back.body.ok], [200, true]);
  is("the code is nobody's", await owner(PROMO), "");
  is("its room is given back", await used(), before);
  is("taking back a code nobody holds is false", await takeCodeBack(store, PROMO), false);
  const none = await post({ action: "code", promo: PROMO, id: "" });
  is("and the route still says 'unknown' for it", [none.status, none.body.ok, none.body.error], [400, false, "unknown"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
