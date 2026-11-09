/**
 * A take of studio (or public) requests that could not tell whether it was taken is unknown, never "used up" (rule 24).
 * Synthetic only: the in-memory Redis double, no provider reached.
 *
 * Before: lib/affiliates.ts `take` swallowed any error a charge threw (`charge(units).catch(() => null)`) and read it
 * as "not taken": the studio answered 429 "studio_used" (the creator told their requests were spent), a bulk change
 * named everyone as "used", an undo said `used: true`, and an emailed invitation answered "resting".
 *
 * Now: a charge that throws is unknown. Nothing is read or written for it (so nobody is approved, and no approval email can go); the cap check throws
 * UnknownReplyError (the studio's 503 "unavailable"), a bulk change names those left as "unavailable" ("We could not
 * check it just now"), an undo is not `used`, and an invitation throws (the link page's "error"), the link kept.
 * A charge that answers null (confirmed not taken) still means "used" / "resting".
 */
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import {
  type Charge,
  StudioNotPaidError,
  decideMany,
  openAffiliateLink,
  partnerShareProblem,
  readAffiliate,
  setPartnerShare,
  setRatesMany,
  undoMany,
} from "@/lib/affiliates";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

/** Takes asked for, and what each answered: a working hold, a confirmed refusal (null), or an unknown (throws). */
let asked = 0;
const healthy: Charge = async () => {
  asked += 1;
  return { give: async () => {}, force: async () => {} };
};
const refused: Charge = async () => {
  asked += 1;
  return null;
};
const unknown: Charge = async () => {
  asked += 1;
  throw new Error("the allowance counter answered in an unknown shape");
};
/** Healthy for the first `n` takes, unknown after. */
const unknownAfter = (n: number): Charge => {
  let seen = 0;
  return async (units) => (++seen <= n ? healthy(units) : unknown(units));
};

async function caught<T>(work: () => Promise<T>): Promise<unknown> {
  try {
    return { value: await work() };
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "spinner@example.com";
  await claimHandle(owner, "spinnershop", "Spinner store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1spinnershop77", true);
  const made = await addProduct(owner, "Spindle Course", "", "40");
  const product = made.ok ? made.product.id : "";
  const saved = await setAffiliateSetting(owner, parseAffiliateSetting({ enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {}, pending: null }));
  is("(the program is on, 5% to affiliates)", saved.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const statusOf = async (id: string) => (await readAffiliate(await store(), id))?.status;
  let tokens = 0;
  const link = async (email: string, share?: { percent: number; products: string[] }) => {
    const token = String(++tokens).padStart(64, "d");
    const grant = { s: (await store()).statsId, e: email, n: "", ...(share ? { k: 1, p: share } : {}) };
    await redis.pipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", 600]]);
    return token;
  };
  const apply = async (email: string) => {
    const opened = await openAffiliateLink(await store(), await link(email));
    if (!opened.ok) throw new Error(`no application for ${email}`);
    return opened.affiliate.id;
  };
  const a = await apply("a@example.com");
  const b = await apply("b@example.com");
  const c = await apply("c@example.com");
  is("(C, waiting, is given 10% of the course)", Boolean(await setPartnerShare(await store(), c, { percent: 10, products: [product] })), true);
  const share = { percent: 10, products: [product] };

  part("1. The 90% cap check when the take is unknown");
  asked = 0;
  is("unknown: UnknownReplyError, never StudioNotPaidError (the studio's 503, not 429 'studio_used')", await caught(async () => partnerShareProblem(await store(), share, null, unknown)), "UnknownReplyError");
  is("(asked once)", asked, 1);
  is("control, refused: StudioNotPaidError", await caught(async () => partnerShareProblem(await store(), share, null, refused)), "StudioNotPaidError");
  is("control, taken: checked (inside the cap)", await caught(async () => partnerShareProblem(await store(), share, null, healthy)), { value: null });
  is("(the error classes are the library's)", [new UnknownReplyError("x").name, new StudioNotPaidError().name], ["UnknownReplyError", "StudioNotPaidError"]);

  part("2. Approving several at once when the first take is unknown");
  const blind = await decideMany(await store(), [a, b], "approve", unknown);
  is("both named as not checked just now, never 'used'", blind, { before: [], held: [{ id: a, email: "", why: "unavailable" }, { id: b, email: "", why: "unavailable" }] });
  is("both still wait", [await statusOf(a), await statusOf(b)], ["pending", "pending"]);
  const spent = await decideMany(await store(), [a, b], "approve", refused);
  is("control, refused: 'used'", spent.held.map((one) => one.why), ["used", "used"]);

  part("3. Approving one plain and one with a share when the lock's take is unknown");
  // Takes: the records (1), the writes (2), then the partner lock and the store (3): unknown from there.
  const mixed = await decideMany(await store(), [a, c], "approve", unknownAfter(2));
  is("A approved, C named as not checked just now", [mixed.before.map((one) => one.id), mixed.held], [[a], [{ id: c, email: "c@example.com", why: "unavailable" }]]);
  is("A approved; C still waits", [await statusOf(a), await statusOf(c)], ["approved", "pending"]);

  part("4. Undoing in bulk when the take is unknown");
  const undo = await undoMany(await store(), [{ id: a, status: "pending", decidedAt: 0 }], "approve", Date.now(), unknown);
  is("not 'used': nothing put back, one left to try again", undo, { undone: 0, left: 1, used: false });
  is("A stays approved", await statusOf(a), "approved");
  const undoSpent = await undoMany(await store(), [{ id: a, status: "pending", decidedAt: 0 }], "approve", Date.now(), refused);
  is("control, refused: used", undoSpent.used, true);

  part("5. Changing several shares when the take is unknown");
  const rates = await setRatesMany(await store(), [a], 3, unknown);
  is("named as not checked just now, never 'used'", rates?.refused, [{ id: a, email: "", why: "unavailable" }]);
  const ratesSpent = await setRatesMany(await store(), [a], 3, refused);
  is("control, refused: 'used'", ratesSpent?.refused.map((one) => one.why), ["used"]);

  part("6. An emailed invitation with a share when the take is unknown");
  const token = await link("p@example.com", share);
  is("unknown: thrown (the link page's 'error'), never 'resting'", await caught(async () => openAffiliateLink(await store(), token, unknown)), "UnknownReplyError");
  const [kept] = (await redis.pipeline([["GET", linkKey(token)]])) as unknown[];
  is("the link is kept", typeof kept, "string");
  is("control, refused: 'resting'", await caught(async () => openAffiliateLink(await store(), token, refused)), { value: { ok: false, reason: "resting" } });
  const joined = (await caught(async () => openAffiliateLink(await store(), token, healthy))) as { value?: { ok: boolean } };
  is("control, taken: joined", joined.value?.ok, true);
  done();
}
main();
