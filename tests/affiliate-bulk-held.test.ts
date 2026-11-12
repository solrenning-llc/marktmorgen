/**
 * Approving several applications at once says who was left waiting, and why (#2995 follow-up). Synthetic only: the
 * in-memory Redis double, through the real route, and the words the studio shows (lib/affiliate-bulk-words.ts).
 *
 * Before: somebody whose share would pass the 90% cap, or who could not be checked just now, was left pending in
 * silence: the studio said "1 application approved" and nothing about the other.
 *
 * Now: the route answers who was left (`held`: id, email, why) and the studio shows one plain sentence for each,
 * beside the count of those approved. Changing the share of several affiliates at once says the same (`refused`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { acceptPartnership, openAffiliateLink, readAffiliate } from "@/lib/affiliates";
import { heldLines } from "@/lib/affiliate-bulk-words";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_partner_approve_only";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
let peopleQueued = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (peopleQueued && one?.[0] === "HGETALL" && /^nl:aff:[^:]+:people$/.test(String(one[1]))) {
    await real(commands);
    return ["QUEUED"];
  }
  return real(commands);
}) as typeof redis.pipeline;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;
type Reply = { status: number; body: { ok?: boolean; error?: string; before?: { id: string }[]; held?: { id: string; email: string; why: string }[] } };

async function main(): Promise<void> {
  redis.clear();
  const owner = "weaver@example.com";
  await claimHandle(owner, "weavershop", "Weaver store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1weavershocff6", true);
  await setSubscription(owner, { customerId: "cus_weaver", subscriptionId: "sub_weaver", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>): Promise<Reply> => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply["body"] };
  };
  const made = await addProduct(owner, "Loom Course", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const store = async () => (await storeForEmail(owner))!;
  const statusOf = async (id: string) => (await readAffiliate(await store(), id))?.status;
  let tokens = 0;
  const apply = async (email: string) => {
    const token = String(++tokens).padStart(64, "c");
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: (await store()).statsId, e: email, n: "" }), "EX", 600]]);
    const opened = await openAffiliateLink(await store(), token);
    if (!opened.ok) throw new Error(`no application for ${email}`);
    return opened.affiliate.id;
  };
  const c = await apply("c@example.com");
  const e = await apply("e@example.com");
  is("(C, waiting, is given 10% of the course)", (await post({ action: "share", id: c, percent: 10, products: [product] })).body.ok, true);
  const x = await acceptPartnership(await store(), "x@example.com", { percent: 80, products: [product] });
  is("(X accepted 80%: 80 + 5% = 85)", x.ok, true);

  part("1. Approving C and E at once: E approved, C left waiting, and said so");
  const bulk = await post({ action: "bulk", decision: "approve", ids: [c, e] });
  is("E approved", [bulk.status, (bulk.body.before ?? []).map((b) => b.id), await statusOf(e)], [200, [e], "approved"]);
  is("C named as left waiting by the cap", bulk.body.held, [{ id: c, email: "c@example.com", why: "cap" }]);
  is("C still waits", await statusOf(c), "pending");

  part("2. Approving C when the program's people cannot be read");
  peopleQueued = true;
  const blind = await post({ action: "bulk", decision: "approve", ids: [c] });
  peopleQueued = false;
  is("C named as left waiting, not checked", [blind.status, blind.body.held], [200, [{ id: c, email: "c@example.com", why: "unavailable" }]]);
  is("C still waits", await statusOf(c), "pending");

  part("3. The words the studio shows");
  is(
    "one sentence each, in plain words, with what to do",
    heldLines([{ id: c, email: "c@example.com", why: "cap" }, { id: e, email: "e@example.com", why: "unavailable" }], "approve"),
    [
      "c@example.com is still waiting. Approving them would let partners and affiliates together take more than 90% of a sale. Lower a partner's share or the commission first, then approve them.",
      "e@example.com is still waiting. We could not check it just now. Try again in a moment.",
    ],
  );
  is(
    "for a change of share, the same",
    heldLines([{ id: c, email: "c@example.com", why: "cap" }, { id: e, email: "e@example.com", why: "unavailable" }], "rate"),
    [
      "c@example.com keeps their share. The new one would let partners and affiliates together take more than 90% of a sale. Lower a partner's share first.",
      "e@example.com keeps their share. We could not check it just now. Try again in a moment.",
    ],
  );
  is("nobody left: no sentence", heldLines([], "approve"), []);
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  is("the studio shows them after approving several", /heldLines\(lastBulk\.held, "approve"\)/.test(studio), true);
  is("and after changing several shares", /heldLines\(last\.refused, "rate"\)/.test(studio), true);
  done();
}
main();
