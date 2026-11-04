/**
 * 630 [HN6](2), unit 2: notice before a cut, through the real save route
 * (app/api/store/affiliates/route.ts), the store's setting
 * (lib/affiliate-setting.ts) and the studio's form (components/affiliate-studio.tsx).
 * A cut saved with notice leaves the old share in force and the new one
 * waiting for its day; read on that day the new one is in force; a notice
 * out of range is refused; a pending cut is never taken from the request;
 * saving with no notice cannot bring a running notice forward; the studio
 * shows the new terms in the form, the date and what changes.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { parseAffiliateSetting, commissionRate } from "@/lib/affiliate-setting";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;

async function main(): Promise<void> {
  redis.clear();
  const owner = "notice@example.com";
  await claimHandle(owner, "noticeshop", "Notice Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Noticexxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_notice", subscriptionId: "sub_notice", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const session = await openSession(owner);
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], rates: {} as Record<string, number> };
  const save = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(
      new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ ...terms, ...body }) }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const setting = async () => (await storeForEmail(owner))!.affiliates;

  part("A program without notice works as before");
  is("saved", (await save({ percent: 30, days: 60, rates: { [product]: 40 } })).body.ok, true);
  is("a cut with no notice applies at once", [(await save({ percent: 25, days: 60, rates: { [product]: 40 } })).body.ok, (await setting()).percent, (await setting()).pending ?? null], [true, 25, null]);

  part("A cut with notice waits for its day");
  await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice: 14 });
  const before = Date.now();
  is("saved with fourteen days' notice", (await save({ percent: 20, days: 30, rates: { [product]: 0 }, notice: 14 })).body.ok, true);
  const waiting = await setting();
  is("today: the old share, window and product share", [waiting.percent, waiting.days, commissionRate(waiting, product)], [30, 60, 40]);
  is("the new ones wait, with the notice kept", [waiting.pending?.percent, waiting.pending?.days, waiting.pending?.rates[product], waiting.notice], [20, 30, 0, 14]);
  const day = waiting.pending?.from ?? 0;
  is("the day is fourteen days from the save", Math.abs(day - (Math.floor(before / 1000) + 14 * DAY)) <= 2, true);
  const kept = { ...waiting };
  is("read the second before the day: still the old terms", parseAffiliateSetting(kept, (day - 1) * 1000).percent, 30);
  const after = parseAffiliateSetting(kept, day * 1000);
  is("read on the day: the new terms, nothing waiting", [after.percent, after.days, commissionRate(after, product), after.pending], [20, 30, 0, null]);

  part("Saving again during the notice");
  is("another field saved with the same new terms keeps the day", [(await save({ percent: 20, days: 30, rates: { [product]: 0 }, notice: 14, payday: 5 })).body.ok, (await setting()).pending?.from], [true, day]);
  is("a deeper cut with no notice now still waits for that day", [(await save({ percent: 10, days: 30, rates: { [product]: 0 }, notice: 0 })).body.ok, (await setting()).percent, (await setting()).pending?.percent, (await setting()).pending?.from], [true, 30, 10, day]);
  is("putting the old terms back clears it", [(await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice: 0 })).body.ok, (await setting()).pending ?? null], [true, null]);

  part("Refused, or never taken from the request");
  for (const notice of [2, 91, 7.5, "soon"]) is(`notice ${JSON.stringify(notice)} refused`, (await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice })).body.error, "notice");
  await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice: 7 });
  const forged = await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice: 7, pending: { percent: 1, rates: {}, days: 1, from: 1 } });
  is("a pending cut sent in the request is ignored", [forged.body.ok, (await setting()).percent, (await setting()).pending ?? null], [true, 30, null]);
  await save({ percent: 30, days: 60, rates: { [product]: 40 }, notice: 30 });
  await save({ percent: 20, days: 60, rates: { [product]: 40 }, notice: 0 });
  is("the program's own notice protects a cut saved while switching notice off", [(await setting()).percent, (await setting()).pending?.percent], [30, 20]);

  part("The studio");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("the form starts from the terms a notice leads to", studio.includes("const target = setting.pending ?? setting;"), true);
  is("the notice is a labeled field with its help", studio.includes('htmlFor="aff-notice"') && studio.includes('aria-describedby="aff-notice-help"'), true);
  is("the day and what changes are shown", studio.includes("these change:") && studio.includes("noticeLines(setting, setting.pending"), true);
  is("the notice's refusal has words", studio.includes("days of notice from"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
