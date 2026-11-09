/**
 * The second tier of an affiliate programme (lib/affiliate-setting.ts
 * secondTier, lib/affiliates.ts tierLines; added 13 October 2026). Checked:
 *
 *   - the choice as it is kept, and only the choices there are;
 *   - somebody who applies through an approved affiliate's invitation link
 *     joins carrying that affiliate and the percent of that day; not through
 *     a pending affiliate's, not their own under another address, and not
 *     when the programme has no second tier;
 *   - the inviting affiliate earns the percent on each sale the recruit
 *     brings, after refunds, on top of the recruit's own share, which does
 *     not change;
 *   - never on the recruit's own purchase, a partner share, a bonus or
 *     another second tier; never past the cap; nothing while the recruit is
 *     held; nothing on sales after the inviting affiliate was removed;
 *   - each affiliate's own page shows their second tier and never the
 *     recruit's sales as their own.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { type Affiliate, type Line, openAffiliateLink, readAffiliate, readBook, recruiterFor, requestAffiliateLink, tierLines } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.RESEND_API_KEY = "re_test_tier_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_tier_only_a_stand_in";
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    mails.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const CAL = "cccccccccccc";

const person = (id: string, email: string, code: string, over: Partial<Affiliate> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...over });
const sale = (ref: string, aff: string, base: number, over: Record<string, unknown> = {}) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 3600, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click", ...over });
const tokenIn = (mail: string) => /token=([0-9a-f]{64})/.exec(mail)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();

  part("The choice");
  is("a second tier from the list is kept", parseAffiliateSetting({ secondTier: 5 }).secondTier, 5);
  is("anything else is none", [parseAffiliateSetting({ secondTier: 7 }).secondTier, parseAffiliateSetting({}).secondTier], [0, 0]);

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 0 });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:emails`, "ana@example.com", ANA],
    ["HSET", `nl:aff:${statsId}:people`, CAL, person(CAL, "cal@example.com", "cal", { status: "pending" })],
    ["HSET", `nl:aff:${statsId}:codes`, "cal", CAL],
  ]);

  part("Joining through an invitation link");
  is("no second tier, no recruiter", await recruiterFor(store, "ana", "bea@example.com"), null);
  await setAffiliateSetting(OWNER, { ...store.affiliates, secondTier: 5 });
  store = (await storeForEmail(OWNER))!;
  is("an approved affiliate's link brings somebody", (await recruiterFor(store, "ana", "bea@example.com"))?.id, ANA);
  is("a pending one's does not", await recruiterFor(store, "cal", "bea@example.com"), null);
  is("nor their own, written another way", await recruiterFor(store, "ana", "ana+two@example.com"), null);

  is("the emailed link is sent", await requestAffiliateLink({ store, email: "bea@example.com", note: "", by: "ana", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  // The programme's percent changes after the email went out, and before the link is opened: the day they join decides.
  await setAffiliateSetting(OWNER, { ...store.affiliates, secondTier: 10 });
  store = (await storeForEmail(OWNER))!;
  const opened = await openAffiliateLink(store, tokenIn(mails[mails.length - 1]));
  if (!opened.ok) throw new Error("not opened");
  is("they join carrying who invited them, at the percent of the day they joined", opened.affiliate.by, { id: ANA, percent: 10 });
  await setAffiliateSetting(OWNER, { ...store.affiliates, secondTier: 5 });
  store = (await storeForEmail(OWNER))!;
  const bea = opened.affiliate.id;
  is("and read back so", (await readAffiliate(store, bea))?.by, { id: ANA, percent: 10 });
  // The creator approves them.
  await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, bea, JSON.stringify({ ...opened.affiliate, status: "approved", decidedAt: Date.now() })]]);

  part("What the inviting affiliate earns");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", sale("cs_one", bea, 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_own", sale("cs_own", bea, 5_000, { self: true })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_ana", sale("cs_ana", ANA, 2_000)],
  ]);
  let book = await readBook(store);
  const tier = book.lines.filter((l) => l.how === "tier2");
  is("one second-tier line, for the sale the recruit brought", tier.map((l) => [l.aff, l.rate, l.commission, l.base]), [[ANA, 10, 1_000, 10_000]]);
  is("the recruit's own share is untouched", book.lines.find((l) => l.ref === "cs_one")?.commission, 3_000);
  const row = (id: string) => book.rows.find((r) => r.affiliate.id === id);
  is("the inviting affiliate is owed their own sale and the second tier; the second tier is not a sale of theirs", [row(ANA)?.earned, row(ANA)?.sales], [600 + 1_000, 1]);

  const ana = await readBook(store, ANA);
  is("their own page: their own sale and the second tier, never the recruit's sale", ana.lines.map((l) => [l.how, l.aff]).sort(), [["click", ANA], ["tier2", ANA]]);
  const beas = await readBook(store, bea);
  is("the recruit's page: only their own", beas.lines.map((l) => l.how).sort(), ["click", "click"]);

  part("Where it stops");
  const base = (over: Partial<Line>): Line => ({ ref: "x", pi: "", aff: bea, at: NOW, product: "", title: "", base: 10_000, total: 10_000, currency: "usd", rate: 30, self: false, how: "click", refunded: 0, commission: 3_000, status: "earned", ...over });
  const blank = { rate: null, paypal: "", share: null, cleared: null, by: null };
  const everyone: Affiliate[] = [
    { ...blank, ...(JSON.parse(person(ANA, "ana@example.com", "ana")) as Partial<Affiliate>) } as Affiliate,
    { ...blank, ...(JSON.parse(person(bea, "bea@example.com", "bea")) as Partial<Affiliate>), by: { id: ANA, percent: 10 } } as Affiliate,
  ];
  const none = new Map();
  is("not on a partner share, a bonus or another second tier", tierLines(everyone, [base({ how: "partner" }), base({ how: "bonus" }), base({ how: "tier2" })], none), []);
  is("a membership payment counts", tierLines(everyone, [base({ how: "recurring" })], none).length, 1);
  is("never past the cap", tierLines(everyone, [base({ rate: 85, commission: 8_500 })], none)[0]?.rate, 5);
  is("partners' shares of the same sale count toward the cap", tierLines(everyone, [base({ ref: "cs_p", rate: 60 }), base({ ref: "cs_p:pppppppppppp", aff: "pppppppppppp", how: "partner", rate: 25, commission: 2_500 })], none)[0]?.rate, 5);
  is("nothing at the cap", tierLines(everyone, [base({ rate: 90, commission: 9_000 })], none), []);
  is("after a refund, on what was kept", tierLines(everyone, [base({ refunded: 4_000, commission: 1_800, status: "partly refunded" })], none)[0]?.commission, 600);
  is("nothing while the recruit is held", tierLines(everyone, [base({})], new Map([[bea, ["same-address"]]])), []);
  const removed = everyone.map((a) => (a.id === ANA ? { ...a, status: "removed" as const, decidedAt: (NOW - 100) * 1000 } : a));
  is("after the inviting affiliate was removed: sales before it still count, later ones not", tierLines(removed, [base({ at: NOW - 200 }), base({ at: NOW })], none).map((l) => l.at), [NOW - 200]);

  part("Refunded");
  // The whole of the recruit's sale given back: nothing for either of them.
  globalThis.fetch = (async (input: string | URL | Request) =>
    String(input).includes("/refunds")
      ? new Response(JSON.stringify({ object: "list", data: [{ status: "succeeded", payment_intent: "pi_cs_one", amount: 10_000 }], has_more: false }), { status: 200 })
      : new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
  store = { ...store, stripeAccountId: "acct_test_tier" };
  book = await readBook(store);
  is("a sale refunded in full earns no second tier", [book.lines.some((l) => l.how === "tier2"), book.rows.find((r) => r.affiliate.id === ANA)?.earned], [false, 600]);

  done();
}

void main();
