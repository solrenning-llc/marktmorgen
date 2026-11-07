/**
 * Callers of a store read that turned an unreadable record into "no store" (rule 24; Claude 5's MEDIUM B on #2878).
 * Since #2878, storeForEmail throws UnknownReplyError on a record it cannot read; these callers caught that throw as
 * null and acted on "gone". Each part runs a healthy control and a confirmed-absence control first.
 *   1. releaseRestarted (lib/closing-holds.ts): an unreadable record is never "gone" and never leaves the held line,
 *      so a restarted store's members are not stranded there.
 *   2. The affiliates route's invite (app/api/store/affiliates/route.ts): an unreadable invitee record answers 503
 *      and sends nothing, instead of emailing the offer to an inbox as if the address had no store here.
 * Synthetic data only; the email provider is a mocked fetch.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { HELD_INDEX, releaseRestarted } from "@/lib/closing-holds";
import { waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
const original: Pipe = redis.pipeline.bind(redis);
const FAR = Date.now() + 60_000;
const ownerKey = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref.toLowerCase()}`).digest("hex").slice(0, 40)}`;
const heal = () => { redis.pipeline = original as typeof redis.pipeline; };

/** Every GET of `key` answers `value` until healed. */
function getAnswers(key: string, value: unknown) {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await original(commands);
    return answer.map((v, i) => (commands[i]?.[0] === "GET" && commands[i]?.[1] === key ? value : v));
  }) as typeof redis.pipeline;
}

async function firstStore(email: string, handle: string) {
  const made = await claimHandle(email, handle, "Shop", "");
  if (!made.ok) throw new Error(`could not make ${handle}: ${made.reason}`);
  return made.store;
}

async function main() {
  let mails = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const where = String(url instanceof Request ? url.url : url);
    if (where.includes("resend") || where.includes("amazonaws")) {
      mails += 1;
      return new Response(JSON.stringify({ id: "mail_test" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "down" }), { status: 500 });
  }) as typeof fetch;

  part("1. releaseRestarted: an unreadable record is never gone");
  redis.clear();
  const cai = await firstStore("cai@example.com", "caishop");
  const caiRef = storeRef(cai);
  const ENDED = Date.now() - 10 * 86_400_000;
  await original([["ZADD", HELD_INDEX, ENDED, caiRef]]);
  const healthy = await releaseRestarted(FAR, async () => false);
  is("control: a readable restarted store is not gone", healthy.find((r) => r.key === caiRef)?.state === "gone", false);
  for (const [label, value] of [["text that is not JSON", "{cut"], ["a number", 7], ["an empty string", ""], ["JSON null", "null"], ["a list", ["x"]]] as const) {
    await original([["ZADD", HELD_INDEX, ENDED, caiRef]]);
    getAnswers(ownerKey(caiRef), value);
    const run = await releaseRestarted(FAR, async () => false);
    heal();
    is(`record read as ${label}: held for tomorrow, never gone`, run.find((r) => r.key === caiRef)?.state, "held");
    is(`record read as ${label}: still in the held line`, (await original([["ZSCORE", HELD_INDEX, caiRef]]))[0] !== null, true);
  }
  const ghost = "ghost@example.com";
  await original([["ZADD", HELD_INDEX, ENDED, ghost]]);
  const absent = await releaseRestarted(FAR, async () => false);
  is("control: a store Redis says is not there (nil) is gone", absent.find((r) => r.key === ghost)?.state, "gone");
  is("control: and it leaves the held line", (await original([["ZSCORE", HELD_INDEX, ghost]]))[0], null);

  part("2. The affiliates invite: an unreadable invitee record answers 503 and sends nothing");
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_only";
  const owner = "inviter@example.com";
  await claimHandle(owner, "invitershop", "Inviter Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Invitexxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_inviter", subscriptionId: "sub_inviter", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Bread Basics", "", "40");
  const product = made.ok ? made.product.id : "";
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(
      new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; waiting?: boolean } };
  };
  const on = await post({ action: "settings", enabled: true, rule: "last", percent: 20, days: 60, payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], rates: {} });
  if (!on.body.ok) throw new Error(`affiliate program not switched on: ${on.body.error}`);
  const invite = (to: string) => post({ action: "invite", email: to, percent: 10, products: [product] });

  const here = "partner@example.com";
  await firstStore(here, "partnershop");
  const kept = await invite(here);
  is("control: a readable store here is asked in its own studio", [kept.status, kept.body.ok, kept.body.waiting], [200, true, true]);
  is("control: the offer waits in that studio", (await waitingFor(here)).length, 1);

  const other = "other@example.com";
  await firstStore(other, "othershop");
  for (const [label, value] of [["text that is not JSON", "{cut"], ["a number", 7], ["JSON null", "null"]] as const) {
    mails = 0;
    getAnswers(ownerKey(other), value);
    const unread = await invite(other);
    heal();
    is(`invitee record read as ${label}: 503, try again`, [unread.status, unread.body.ok], [503, false]);
    is(`invitee record read as ${label}: no email sent as if no store were here`, mails, 0);
    is(`invitee record read as ${label}: no offer left in a studio`, (await waitingFor(other)).length, 0);
  }
  is("the invitee's own store is untouched", (await storeForEmail(other))?.handle, "othershop");

  mails = 0;
  const outside = await invite("nobody@example.com");
  is("control: an address with no store here (nil) is invited by email, not refused", [outside.status === 503, (await waitingFor("nobody@example.com")).length], [false, 0]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
