/**
 * The affiliates route's invite (app/api/store/affiliates/route.ts) asks whether the invited address already has a
 * store here: one that does is offered the partnership in its own studio, one that does not is emailed. The read was
 * `storeForEmail(to).catch(() => null)`, so a request to the store that failed (rule 24: unknown, not "no store")
 * read as "no store here": the offer was emailed to an inbox that has a studio. Now a failed read answers 503, sends
 * nothing and leaves nothing waiting. Claude 5's MEDIUM B on #2878, carried by #3073 (Claude 4), whose base #2878
 * closed unmerged; the other half of #3073 (lib/closing-holds.ts) is already on main (93d6df7536).
 *
 * Real route, Redis on tests/redis-stub.ts, the email provider a mocked fetch. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { waitingFor } from "@/lib/partner-invites";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
const original: Pipe = redis.pipeline.bind(redis);
const ownerKey = (ref: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${ref.toLowerCase()}`).digest("hex").slice(0, 40)}`;
const heal = () => { redis.pipeline = original as typeof redis.pipeline; };

/** Every request that GETs `key` fails, as a Redis request that did not get through does. */
function failReading(key: string) {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && c[1] === key)) throw new Error("synthetic: Redis request failed");
    return original(commands);
  }) as typeof redis.pipeline;
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

  part("The affiliates invite: an invitee record that cannot be read answers 503 and sends nothing");
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
  if (!(await claimHandle(here, "partnershop", "Shop", "")).ok) throw new Error("no partner store");
  const kept = await invite(here);
  is("control: a readable store here is asked in its own studio", [kept.status, kept.body.ok, kept.body.waiting], [200, true, true]);
  is("control: the offer waits in that studio", (await waitingFor(here)).length, 1);

  const other = "other@example.com";
  if (!(await claimHandle(other, "othershop", "Shop", "")).ok) throw new Error("no other store");
  mails = 0;
  failReading(ownerKey(other));
  const unread = await invite(other).catch((error: unknown) => ({ status: -1, body: { ok: false, error: String(error) } }));
  heal();
  is("a failed read of the invitee's record: 503, try again", [unread.status, unread.body.ok], [503, false]);
  is("no email sent as if no store were here", mails, 0);
  is("no offer left waiting in a studio", (await waitingFor(other)).length, 0);
  is("the invitee's own store is untouched", (await storeForEmail(other))?.handle, "othershop");

  mails = 0;
  const outside = await invite("nobody@example.com");
  is("control: an address with no store here is invited by email, not refused", [outside.status === 503, (await waitingFor("nobody@example.com")).length], [false, 0]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
