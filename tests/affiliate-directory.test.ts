/**
 * The affiliate directory (lib/affiliate-directory.ts, opened 11 October
 * 2026). What is checked:
 *
 *   - a program is listed only when its creator said yes, it is on with a
 *     share, the store can take a card today and something earns;
 *   - the demo store never, whatever it says;
 *   - each product says what one sale earns at today's price, at its own
 *     share; memberships, payment plans, drafts, free things and products
 *     left out at 0% are not shown as earning;
 *   - the order is the one written on the page;
 *   - unchecking the box takes the program off the page at once.
 */
import { addProduct, claimHandle, setProductExtras, ensureStatsId, setAffiliateSetting, setProductHidden, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { DIRECTORY_BUILD_SECONDS, DIRECTORY_ORDER, DirectoryBusyError, MIN_CLICKS_FOR_RATES, directoryNumbers, directoryRow, readDirectory, sortRows, type DirectoryRow } from "@/lib/affiliate-directory";
import { programNumbers } from "@/lib/affiliates";
import { redisPipeline } from "@/lib/redis";
import { HOUSE_OWNER } from "@/lib/house-store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

async function selling(email: string, handle: string, name: string) {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";

  part("Who is listed");
  const A = "baker@example.com";
  await selling(A, "breadhouse", "Bread House");
  const loaf = await addProduct(A, "Sourdough Guide", "", "20", null);
  const course = await addProduct(A, "Pastry Course", "", "120", null);
  const draft = await addProduct(A, "Secret Draft", "", "50", null);
  const out = await addProduct(A, "Left Out", "", "40", null);
  if (!loaf.ok || !course.ok || !draft.ok || !out.ok) throw new Error("no product");
  await setProductHidden(A, draft.product.id, true);
  const terms = { enabled: true, percent: 30, days: 30, rule: "last", payday: 15, hold: 30, buyers: true, directory: false, lifetime: true, rates: { [course.product.id]: 40, [out.product.id]: 0 } };
  await setAffiliateSetting(A, parseAffiliateSetting(terms));
  is("not without the creator's yes", directoryRow((await storeForEmail(A))!), null);
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true }));
  const row = directoryRow((await storeForEmail(A))!) as DirectoryRow;
  is("with it, the program's own terms", [row.handle, row.percent, row.topRate, row.days, row.rule, row.lifetime, row.payday, row.hold, row.buyers], ["breadhouse", 30, 40, 30, "last", true, 15, 30, true]);
  is(
    "each product that earns, with what one sale earns at its own share; a draft and a product left out are not there",
    row.products.map((p) => [p.title, p.rate, p.earnCents]),
    [["Sourdough Guide", 30, 600], ["Pastry Course", 40, 4800]],
  );
  is("the best one sale earns", row.topEarnCents, 4800);

  // 397 [SL1]: a membership earns on its payments only when the store credits them, and says for how long.
  const club = await addProduct(A, "Bakers' Club", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no membership");
  const noMembers = directoryRow((await storeForEmail(A))!) as DirectoryRow;
  is("a membership not credited is not there", noMembers.products.some((p) => p.title === "Bakers' Club"), false);
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true, recurring: 12 }));
  const members = directoryRow((await storeForEmail(A))!) as DirectoryRow;
  const listed = members.products.find((p) => p.title === "Bakers' Club");
  is("credited, it is there: what one monthly payment earns, for the months the store set", [listed?.earnCents, listed?.months, listed?.interval, listed?.trialDays], [300, 12, "month", undefined]);
  // A free trial as long as the months credited leaves no payment that earns: not listed.
  const trialClub = await addProduct(A, "Trial Club", "", "10", { interval: "month", trialDays: 30, payments: 0 });
  if (!trialClub.ok) throw new Error("no trial membership");
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true, recurring: 1 }));
  is("a trial that uses up the months credited is not there", (directoryRow((await storeForEmail(A))!) as DirectoryRow).products.some((p) => p.title === "Trial Club"), false);
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true, recurring: 12 }));
  is("with more months than its trial, it is, and says its free days", (directoryRow((await storeForEmail(A))!) as DirectoryRow).products.find((p) => p.title === "Trial Club")?.trialDays, 30);
  await setProductHidden(A, trialClub.product.id, true);
  is("a product sold once has no months", members.products.find((p) => p.title === "Sourdough Guide")?.months, undefined);
  // A product that can also be paid in parts still earns on its one-time sale, so it is there.
  const planned = await setProductExtras(A, course.product.id, { plan: { payments: 3, interval: "month", amountCents: 4500 } });
  const withPlan = (directoryRow((await storeForEmail(A))!) as DirectoryRow).products.find((p) => p.title === "Pastry Course");
  is("a product with a payment plan stays at its one-time sale; while memberships and plans earn, no \"paid in full\"", [planned.ok, withPlan?.earnCents, withPlan?.paidInFull], [true, 4800, undefined]);
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true }));
  is("while they earn nothing, it says a sale paid in full", (directoryRow((await storeForEmail(A))!) as DirectoryRow).products.find((p) => p.title === "Pastry Course")?.paidInFull, true);
  await setProductExtras(A, course.product.id, { plan: null });
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true }));

  const B = "nostripe@example.com";
  await claimHandle(B, "nostripe", "No Stripe", "");
  await ensureStatsId(B);
  await addProduct(B, "Guide", "", "10", null);
  await setAffiliateSetting(B, parseAffiliateSetting({ ...terms, rates: {}, directory: true }));
  is("not a store that cannot take a card", directoryRow((await storeForEmail(B))!), null);

  const C = "free@example.com";
  await selling(C, "freeonly", "Free Only");
  await addProduct(C, "Free Thing", "", "0", null);
  await setAffiliateSetting(C, parseAffiliateSetting({ ...terms, rates: {}, directory: true }));
  is("not a store where nothing earns", directoryRow((await storeForEmail(C))!), null);

  await selling(HOUSE_OWNER, "harborkitchen", "Harbor Kitchen");
  await addProduct(HOUSE_OWNER, "Meal Plan", "", "15", null);
  await setAffiliateSetting(HOUSE_OWNER, parseAffiliateSetting({ ...terms, rates: {}, directory: true }));
  is("never the demo store: it is made up", directoryRow((await storeForEmail(HOUSE_OWNER))!), null);

  part("The order written on the page");
  const D = "yoga@example.com";
  await selling(D, "yogaroom", "Yoga Room");
  await addProduct(D, "Flow", "", "30", null);
  await addProduct(D, "Breath", "", "10", null);
  await setAffiliateSetting(D, parseAffiliateSetting({ ...terms, percent: 40, rates: {}, directory: true }));
  const rows = await readDirectory();
  is("highest share first, then more products that earn, then name", rows.map((r) => r.handle), ["breadhouse", "yogaroom"]);
  is("ties by share go to more products, then to the name", sortRows([{ ...row, handle: "b", name: "B", topRate: 40, earning: 1 }, { ...row, handle: "a", name: "A", topRate: 40, earning: 1 }, { ...row, handle: "c", name: "C", topRate: 40, earning: 3 }]).map((r) => r.handle), ["c", "a", "b"]);
  is("and it says nobody pays to be higher", DIRECTORY_ORDER.includes("Nobody can pay to be placed higher"), true);

  part("Taken off at once");
  await setAffiliateSetting(D, parseAffiliateSetting({ ...terms, percent: 40, rates: {}, directory: false }));
  // Built less than DIRECTORY_BUILD_SECONDS ago, the page is not built again yet: the next read says unavailable,
  // never the page from before the save (tests/directory-assembly-ceiling.test.ts).
  is("unchecking the box takes the page down at once: never the list from before", await readDirectory().then(() => "listed", (error) => error instanceof DirectoryBusyError), true);
  advance(DIRECTORY_BUILD_SECONDS * 1000);
  is("unchecking the box leaves the page on the next build, not ten minutes later", (await readDirectory()).map((r) => r.handle), ["breadhouse"]);

  part("A program's own numbers, only with a second yes");
  is("listed without them unless the creator also allowed them", (await readDirectory()).find((r) => r.handle === "breadhouse")?.numbers, null);
  const bread = (await storeForEmail(A))!;
  const sid = bread.statsId!;
  const aff = (id: string, decidedAt: number, status = "approved") => JSON.stringify({ id, email: `${id}@example.com`, code: id.slice(0, 6), status, decidedAt });
  const sale = (ref: string, a: string, base: number, rate: number, how: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ref, aff: a, base, rate, how, currency: "usd", ...extra });
  await redisPipeline([
    ["HSET", `nl:aff:${sid}:people`, "aaaaaaaaaaaa", aff("aaaaaaaaaaaa", Date.UTC(2026, 2, 5)), "bbbbbbbbbbbb", aff("bbbbbbbbbbbb", Date.UTC(2026, 5, 1)), "cccccccccccc", aff("cccccccccccc", Date.UTC(2026, 1, 1), "pending")],
    ["HSET", `nl:aff:${sid}:clicks`, "aaaaaaaaaaaa", "150", "bbbbbbbbbbbb", "50"],
    ["HSET", `nl:aff:${sid}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 2000, 30, "click"), "cs_2", sale("cs_2", "aaaaaaaaaaaa", 12000, 40, "click"), "cs_3", sale("cs_3", "bbbbbbbbbbbb", 2000, 30, "code"), "cs_4", sale("cs_4", "bbbbbbbbbbbb", 2000, 30, "click", { self: true }), "cs_5", sale("cs_5", "bbbbbbbbbbbb", 2000, 30, "click", { currency: "eur" })],
    ["HSET", `nl:aff:${sid}:payouts`, "p1", JSON.stringify({ id: "p1", aff: "aaaaaaaaaaaa", cents: 3000, currency: "usd" })],
  ]);
  const raw = await programNumbers(bread);
  is(
    "counted as the creator's book counts: approved affiliates, every click, sales not their own and in the store's currency, earned before refunds, recorded as paid",
    raw,
    { affiliates: 2, clicks: 200, clickSales: 2, clickEarnedCents: 5400, sales: 3, earnedCents: 6000, paidCents: 3000, since: Date.UTC(2026, 2, 5) },
  );
  is("rates per click from 200 clicks: one in a hundred became a sale, $27 earned per 100 clicks", [directoryNumbers(raw)?.conversion, directoryNumbers(raw)?.per100Cents], [1, 2700]);
  is(`and none below ${MIN_CLICKS_FOR_RATES} clicks: one sale would move them too far`, [directoryNumbers({ ...raw!, clicks: 99 })?.conversion, directoryNumbers({ ...raw!, clicks: 99 })?.per100Cents], [null, null]);
  await setAffiliateSetting(A, parseAffiliateSetting({ ...terms, directory: true, numbers: true }));
  advance(DIRECTORY_BUILD_SECONDS * 1000);
  is("with the second yes, the directory shows them", (await readDirectory()).find((r) => r.handle === "breadhouse")?.numbers?.paidCents, 3000);
  is("only an explicit yes counts as one", parseAffiliateSetting({ numbers: "yes" }).numbers, false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
