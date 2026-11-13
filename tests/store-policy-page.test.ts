/**
 * 617 [SZ1], unit 3: a store's policy page is built from what the store is
 * now (lib/store-policy-input.ts): what it sells, PayPal, the pixels switched
 * on, the postal address; it changes with them; the address is kept from a
 * creator's own page names. Synthetic store values; the page's markup is read
 * from its source, as other store page checks do.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, moveProduct, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { visibleIds } from "@/lib/catalog";
import { policyInput, policyInputFrom } from "@/lib/store-policy-input";
import { policyFacts, policyFingerprint } from "@/lib/store-policy-facts";
import { RESERVED_SLUGS } from "@/lib/site-page-rules";
import { NO_PIXELS } from "@/lib/pixels";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const store = { name: "Harbor Kitchen", pixels: { ...NO_PIXELS }, mail: { address: "1 Main St, Portland, OR 97201" } } as unknown as Parameters<typeof policyInputFrom>[0];
const ebook = { priceCents: 1900, file: { pathname: "x" } };
const free = { priceCents: 0, file: { pathname: "y" } };
const club = { priceCents: 900, recurring: { interval: "month" } };
const call = { priceCents: 9900, call: { minutes: 30 } };

part("What the store sells, counting only what is paid for");
is("an ebook: digital", policyInputFrom(store, [ebook], false).sellsDigital, true);
is("a free download alone: nothing sold", [policyInputFrom(store, [free], false).sellsDigital, policyInputFrom(store, [free], false).sellsMemberships], [false, false]);
is("a membership: memberships, not digital content", [policyInputFrom(store, [club], false).sellsMemberships, policyInputFrom(store, [club], false).sellsDigital], [true, false]);
is("a call: neither", [policyInputFrom(store, [call], false).sellsDigital, policyInputFrom(store, [call], false).sellsMemberships], [false, false]);

part("Settings flow into the page, and change it");
const before = policyFacts(policyInputFrom(store, [ebook], false), "en");
const withPixel = policyFacts(policyInputFrom({ ...store, pixels: { ...NO_PIXELS, meta: "123456789012345" } } as typeof store, [ebook], false), "en");
is("a pixel switched on: the measurement section, named by its platform", withPixel.find((s) => s.id === "measurement")?.sentences[0], "Harbor Kitchen measures its ads with Meta.");
is("and a new version", policyFingerprint(withPixel) === policyFingerprint(before), false);
is("PayPal taken: said", policyFacts(policyInputFrom(store, [ebook], true), "en")[0].sentences[2].includes("PayPal"), true);
is("no postal address: no contact section", policyFacts(policyInputFrom({ ...store, mail: null } as typeof store, [ebook], false), "en").some((s) => s.id === "contact"), false);

part("The email footer's postal address is on the page only by the creator's own choice (Claude 1's MEDIUM on #1824)");
// Typed for the footer of list emails (CAN-SPAM), often a home address: never published on a public page unless the
// creator chose it, where they type it.
const footerOnly = { ...store, mail: { fromName: "Harbor Kitchen", address: "12 Elm St, Apt 3, Leeds" } } as typeof store;
const chosen = { ...store, mail: { fromName: "Harbor Kitchen", address: "12 Elm St, Apt 3, Leeds", onPolicies: true } } as typeof store;
is("typed for the emails only: no contact section, the address nowhere on the page", [policyFacts(policyInputFrom(footerOnly, [ebook], false), "en").some((s) => s.id === "contact"), JSON.stringify(policyFacts(policyInputFrom(footerOnly, [ebook], false), "en")).includes("Elm St")], [false, false]);
is("chosen for the page: the contact section with it", policyFacts(policyInputFrom(chosen, [ebook], false), "en").find((s) => s.id === "contact")?.sentences.some((t) => t.includes("12 Elm St, Apt 3, Leeds")), true);
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("the choice is made where the address is typed, unchecked until the creator checks it", [studio.includes("Also show this address on my store's policies page"), studio.includes("useState(mail?.onPolicies === true)"), studio.includes('type="checkbox"')], [true, true, true]);
is("the settings route saves the choice only when it is exactly yes", readFileSync("app/api/store/mail/route.ts", "utf8").includes("body.onPolicies === true"), true);
is("the privacy page says the address is public only by that choice", /postal address[\s\S]{0,200}policies page/.test(readFileSync("app/privacy/page.tsx", "utf8")), true);

part("The page");
const page = readFileSync("app/[handle]/policies/page.tsx", "utf8");
// Read through the paid reader since Claude 1's MEDIUM on #1824 (tests/store-policy-paid-read.test.ts): still built from the store as it is now.
is("built from the store as it is now, in its language", [page.includes("const input = await policyInputPaid(store);"), page.includes("policyFacts(input, store.language)")], [true, true]);
is("its version is the fingerprint of its words", page.includes("const version = policyFingerprint(sections);"), true);
is("says it is not legal advice", page.includes("{notAdvice(store.language)}"), true);
is("one h1, a titled h2 per section, the page's language marked", [(page.match(/<h1\b/g) ?? []).length, page.includes("aria-labelledby={`policy-${section.id}`}"), page.includes("lang={said.lang.locale}")], [1, true, true]);
is("a product read that fails is never quietly left out", [readFileSync("lib/store-policy-input.ts", "utf8").includes("const products = await readListingsAll(store, visibleIds(store));"), /\bcatch\b|\breadListings\(/.test(readFileSync("lib/store-policy-input.ts", "utf8").replace(/\/\/.*$/gm, ""))], [true, false]);
is("a creator's page cannot take its address", RESERVED_SLUGS.has("policies"), true);

/**
 * A stored membership schedule that cannot be read (Codex G's review of #1824): a listing outside the head
 * whose `recurring` is there but not a schedule is unknown, so the page is not built, never built as a store
 * that sells no memberships. An absent or null `recurring` is a product that is not a membership. The record
 * is written by the real writers and then changed in Redis, as a damaged or foreign record would be.
 */
async function storedSchedule() {
  part("A stored membership schedule that cannot be read is unknown, never \"no memberships\"");
  redis.clear();
  const owner = "policy-recurring@example.test";
  await claimHandle(owner, "policyrecurring", "Policy Recurring", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_PolicyRec01", subscriptionId: "sub_PolicyRec01", active: true, period: paidPeriod() });
  for (let i = 0; i < 25; i++) if (!(await addProduct(owner, `Free ${i}`, "", "0", null)).ok) throw Error("fixture free product failed");
  const member = await addProduct(owner, "Monthly club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!member.ok) throw Error("fixture membership failed");
  await moveProduct(owner, member.product.id, "bottom");
  const shop = (await storeForEmail(owner))!;
  is("the membership is listed outside the head", [visibleIds(shop).includes(member.product.id), shop.catalog.head.some((p) => p.id === member.product.id)], [true, false]);
  const key = `nl:catalog:${shop.catalog.id}:l:${member.product.id}`;
  const original = String((await redis.pipeline([["GET", key]]))[0]);
  const stored = async (recurring: unknown, drop = false) => {
    const value = JSON.parse(original);
    if (drop) delete value.recurring;
    else value.recurring = recurring;
    await redis.pipeline([["SET", key, JSON.stringify(value)]]);
    try {
      const input = await policyInput(shop);
      return { memberships: input.sellsMemberships };
    } catch {
      return "unknown";
    }
  };
  is("a readable schedule: memberships", await stored(JSON.parse(original).recurring), { memberships: true });
  for (const [what, recurring] of [
    ["an interval it does not know", { interval: "fortnight", trialDays: 0, payments: 0 }],
    ["a schedule with no interval", { trialDays: 0, payments: 0 }],
    ["an empty object", {}],
    ["a list", []],
    ["true", true],
    ["false", false],
    ["a bare word", "month"],
    ["a number", 1],
  ] as const) {
    is(`${what}: unknown, the page not built`, await stored(recurring), "unknown");
  }
  is("null: not a membership", await stored(null), { memberships: false });
  is("no recurring field at all: not a membership", await stored(undefined, true), { memberships: false });
  is("the readable schedule back: memberships again", await stored(JSON.parse(original).recurring), { memberships: true });
}

/** The choice is kept with the address, and only a yes is a yes. */
async function mailChoice() {
  part("The choice is kept with the store's email settings");
  redis.clear();
  const owner = "policy-mail@example.test";
  await claimHandle(owner, "policymail", "Policy Mail", "");
  await setMailSettings(owner, { fromName: "Policy Mail", address: "12 Elm St, Apt 3, Leeds", onPolicies: true });
  is("checked: kept", (await storeForEmail(owner))!.mail?.onPolicies, true);
  await setMailSettings(owner, { fromName: "Policy Mail", address: "12 Elm St, Apt 3, Leeds" });
  is("unchecked: not kept", (await storeForEmail(owner))!.mail?.onPolicies === true, false);
}

mailChoice().then(storedSchedule).then(done, (e) => {
  console.error(e);
  process.exitCode = 1;
});
