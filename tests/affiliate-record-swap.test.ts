/**
 * Writes of one affiliate's whole record never put back what another write changed in between (#2995 follow-up,
 * money). Synthetic only: the in-memory Redis double, with a second write slipped in between a writer's read and its
 * own write, as two requests at the same instant would do.
 *
 * Before: setAffiliateRate, setPayAddress, releaseHold, the idle warning and a decision each read the whole record,
 * changed one field and wrote the whole record back. A partner's share lowered from 80% to 40% in between came back
 * as 80%: the cap was checked against 40% and the sale paid 80%.
 *
 * Now: each write lands only over exactly the record it read (AFFILIATE_SWAP, a compare-and-set in one script); when
 * the record changed meanwhile, it reads again and changes only its own field. An unknown reply to the swap, or a
 * record that keeps changing, throws and writes nothing: the route answers 503.
 */
import { NextRequest } from "next/server";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { decide, idleSweep, readAffiliate, releaseHold, setAffiliateRate, setPayAddress } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_swap_only";
process.env.RESEND_API_KEY = "re_test_affiliate_idle_only";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "potter@example.com";
const DAY = 86_400;
const real = redis.pipeline.bind(redis);
let people = "";
/** Runs once, just before the next write of the people hash: the other request's write. */
let between: (() => Promise<void>) | null = null;
/** Runs before every write of the people hash: a record that never stops changing. */
let always: (() => Promise<void>) | null = null;
/** The next swap's reply, replaced by this one. */
let swapReply: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  const writes = one && ((one[0] === "HSET" && one[1] === people) || (one[0] === "EVAL" && one[3] === people));
  if (writes) {
    const run = between;
    between = null;
    if (run) await run();
    if (always) await always();
    if (swapReply && one[0] === "EVAL") {
      const reply = swapReply;
      swapReply = null;
      return reply;
    }
  }
  return real(commands);
}) as typeof redis.pipeline;

const ids = { partner: "a1a1a1a1a1a1", quiet: "b2b2b2b2b2b2" };

async function main(): Promise<void> {
  redis.clear();
  const T0 = Math.floor(Date.now() / 1000) - 400 * DAY;
  await claimHandle(OWNER, "pottery", "Pottery store", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwap00001", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 5, idle: 90, idleOn: T0 }));
  const store = async () => (await storeForEmail(OWNER))!;
  people = `nl:aff:${(await store()).statsId}:people`;
  const person = (id: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ id, email: `${id}@example.com`, code: id.slice(0, 5), status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "", ...over });
  await real([
    ["HSET", people, ids.partner, person(ids.partner, { share: { percent: 80, products: ["prod01"] } })],
    ["HSET", people, ids.quiet, person(ids.quiet)],
  ]);
  const read = async (id: string) => (await readAffiliate(await store(), id))!;
  /** The other request: the creator lowering the partner's share, written straight to the record. */
  const lowerShare = (percent: number) => async () => {
    const [raw] = await real([["HGET", people, ids.partner]]);
    await real([["HSET", people, ids.partner, JSON.stringify({ ...JSON.parse(String(raw)), share: { percent, products: ["prod01"] } })]]);
  };
  const shareOf = async () => (await read(ids.partner)).share?.percent;

  part("1. Each writer keeps a share lowered while it was writing");
  between = lowerShare(40);
  await setAffiliateRate(await store(), ids.partner, 4);
  is("an affiliate's own share: written, and the share stays at 40%", [(await read(ids.partner)).rate, await shareOf()], [4, 40]);

  between = lowerShare(30);
  await setPayAddress(await store(), await read(ids.partner), "pay@example.com");
  is("a PayPal address: written, and the share stays at 30%", [(await read(ids.partner)).paypal, await shareOf()], ["pay@example.com", 30]);

  between = lowerShare(20);
  await releaseHold(await store(), ids.partner);
  is("a hold released: written, and the share stays at 20%", [(await read(ids.partner)).cleared !== null, await shareOf()], [true, 20]);

  between = lowerShare(10);
  await decide(await store(), ids.partner, "remove");
  is("a decision: written, and the share stays at 10%", [(await read(ids.partner)).status, await shareOf()], ["removed", 10]);

  part("2. The idle warning keeps what changed meanwhile");
  between = async () => {
    const [raw] = await real([["HGET", people, ids.quiet]]);
    await real([["HSET", people, ids.quiet, JSON.stringify({ ...JSON.parse(String(raw)), rate: 3 })]]);
  };
  const swept = await idleSweep(await store(), (T0 + 120 * DAY) * 1000);
  is("the quiet affiliate is warned", swept.warned, 1);
  is("and the own share set meanwhile stays", (await read(ids.quiet)).rate, 3);

  part("3. An unknown reply to the swap: nothing claimed written");
  swapReply = ["QUEUED"];
  const unknown = await setAffiliateRate(await store(), ids.quiet, 2).then(() => "returned", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
  is("setting a share throws on the unknown reply", unknown, "unknown");
  is("the own share is still 3%", (await read(ids.quiet)).rate, 3);

  part("4. A record that keeps changing: refused, 503, nothing written");
  let n = 0;
  always = async () => {
    const [raw] = await real([["HGET", people, ids.quiet]]);
    await real([["HSET", people, ids.quiet, JSON.stringify({ ...JSON.parse(String(raw)), note: `changed ${++n}` })]]);
  };
  // The plan the studio's route needs, taken only now: the idle warning above is sent as a store without one.
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_potter", subscriptionId: "sub_potter", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "rate", id: ids.quiet, rate: 1 }) }));
  always = null;
  is("the route answers 503 unavailable", [response.status, ((await response.json()) as { error?: string }).error], [503, "unavailable"]);
  is("the own share is still 3%", (await read(ids.quiet)).rate, 3);
  done();
}
main();
