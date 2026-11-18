/**
 * A payment plan's checkout written down when it opens (rememberPlan), and the line format the daily plans job
 * (lib/plans.ts, settlePlans) keeps each plan under. Apart from lib/plans.ts so lib/store-checkout.ts, which writes a
 * plan down whichever door opened its checkout, takes no static import that leads back to it: lib/plans.ts imports
 * the notices, and they reach lib/store-checkout.ts (tests/plans-import-cycle.test.ts).
 */
import { redisPipeline } from "@/lib/redis";

/** Plans being started: a member each, read by the daily plans job. */
export const PENDING = "nl:plans:pending";
export const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
export const ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,64}$/;
const STORE_ID = /^[0-9a-f]{32}$/;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One plan in a line: whose it is, since when its account has refused us, whether its creator was told, and since
 * when a payment after its end has been owed and whether its creator was told about that.
 */
export type Entry = { account: string; session: string; since: number; sid: string; product: string; told: boolean; owed: number; owedTold: boolean };

/** Reads a member; a store or product that is not one of ours is left out, and a member written before them reads. */
export function entryOf(member: string): Entry {
  const [account = "", session = "", since = "", sid = "", product = "", told = "", owed = "", owedTold = ""] = member.split("|");
  return {
    account,
    session,
    since: Number(since),
    sid: STORE_ID.test(sid) ? sid : "",
    product: PRODUCT_ID.test(product) ? product : "",
    told: told === "told",
    owed: /^[0-9]{1,12}$/.test(owed) ? Number(owed) : 0,
    owedTold: owedTold === "told",
  };
}

/** The member for an entry: one with nothing but its time is written as before, one never owed as before too. */
export function memberOf(entry: Entry): string {
  const head = `${entry.account}|${entry.session}|${entry.since}`;
  if (!entry.sid && !entry.product && !entry.told && !entry.owed && !entry.owedTold) return head;
  const base = `${head}|${entry.sid}|${entry.product}`;
  if (!entry.owed && !entry.owedTold) return `${base}${entry.told ? "|told" : ""}`;
  return `${base}|${entry.told ? "told" : ""}|${entry.owed || ""}|${entry.owedTold ? "told" : ""}`;
}

/**
 * Written down when a plan's checkout opens, so it is settled either way. `about` names the store and the product,
 * so the creator can be told if their account refuses us for PLAN_GIVE_UP_DAYS.
 *
 * It returns only once the write is confirmed: the checkout is handed to the buyer on that promise, and a plan the
 * job cannot find is charged past its last payment. So an account or session id the job could not follow, no Redis,
 * or a SADD reply other than exactly 0 or 1 (unknown, short or of another shape) throws, never passes as written
 * (Codex X4 on #4493).
 */
export async function rememberPlan(account: string, session: string, about?: { sid: string; product: string }): Promise<void> {
  if (!ACCOUNT_ID.test(account) || !SESSION_ID.test(session)) throw new Error("A plan's checkout cannot be written down: not a Stripe account and checkout session");
  const sid = about && STORE_ID.test(about.sid) ? about.sid : "";
  const product = about && PRODUCT_ID.test(about.product) ? about.product : "";
  const line = memberOf({ account, session, since: Math.floor(Date.now() / 1000), sid, product, told: false, owed: 0, owedTold: false });
  const replies = await redisPipeline([["SADD", PENDING, line]]);
  const added = Array.isArray(replies) && replies.length === 1 ? replies[0] : undefined;
  if (added !== 0 && added !== 1) throw new Error("Redis did not confirm the plan's checkout was written down");
}
