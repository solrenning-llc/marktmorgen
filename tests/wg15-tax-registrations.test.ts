/**
 * 655 [WG15]: "Where you collect tax", read only from the creator's own
 * Stripe account (lib/tax-registrations.ts, app/studio/tax/page.tsx). With a
 * Stripe stand-in: the list is exactly what Stripe returned; an answer of any
 * other shape, or a list cut short, is "unknown", never an empty list; only a
 * complete list is kept, for half a day; the page is for a role with
 * payments only and says what it is.
 */
import { readFileSync } from "node:fs";
import {
  TAX_REGISTRATION_PAGES,
  TAX_REGISTRATIONS_SECONDS,
  placeOf,
  readPage,
  readRegistration,
  readTaxRegistrations,
  taxLocationsPage,
} from "@/lib/tax-registrations";
import { STRIPE_VERSION } from "@/lib/stripe-connect";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_wg15_only_a_stand_in";

const ACCOUNT = "acct_1TestTaxRegs01";
const reg = (id: string, over: Record<string, unknown> = {}) => ({
  id, object: "tax.registration", active_from: 1_782_000_000, country: "US",
  country_options: { us: { state: "CA", type: "state_sales_tax" } }, created: 1_781_000_000, expires_at: null, livemode: false, status: "active", ...over,
});
let pages: unknown[] = [];
let asked: URL[] = [];
/** The Stripe-Version header each read sent (Claude 4 on #2735). */
let versions: (string | null)[] = [];
let failing = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  versions.push(new Headers(init?.headers).get("Stripe-Version"));
  if (url.hostname !== "api.stripe.com" || url.pathname !== "/v1/tax/registrations") return new Response("{}", { status: 404 });
  asked.push(url);
  if (failing) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  const body = pages[asked.length - 1] ?? { object: "list", data: [], has_more: false };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const store = { stripeAccountId: ACCOUNT };
async function fresh(list: unknown[]) {
  redis.clear();
  pages = list;
  asked = [];
  versions = [];
  return readTaxRegistrations(store);
}

async function main(): Promise<void> {
  part("A row read exactly");
  is("a US state registration", readRegistration(reg("taxreg_A1")), { id: "taxreg_A1", country: "US", region: "CA", type: "state_sales_tax", activeFrom: 1_782_000_000, expiresAt: null });
  is("an EU one with no region", readRegistration(reg("taxreg_B1", { country: "DE", country_options: { de: { type: "oss_union" } } }))?.region, null);
  is("a Canadian province", readRegistration(reg("taxreg_C1", { country: "CA", country_options: { ca: { type: "province_standard", province_standard: { province: "BC" } } } }))?.region, "BC");
  is("not active, another object, a bad id or country, a date that is not whole: nothing", [
    readRegistration(reg("taxreg_D1", { status: "expired" })), readRegistration(reg("taxreg_D2", { object: "tax.settings" })),
    readRegistration(reg("txr_D3")), readRegistration(reg("taxreg_D4", { country: "usa" })), readRegistration(reg("taxreg_D5", { active_from: "1782000000" })),
    readRegistration(reg("taxreg_D6", { expires_at: 1.5 })), readRegistration(reg("taxreg_D7", { country_options: { us: { state: 7 } } })),
  ], [null, null, null, null, null, null, null]);
  is("a page with one odd row is not a page", readPage({ object: "list", data: [reg("taxreg_E1"), { id: "x" }], has_more: false }), null);
  is("a page without has_more, or saying more with nothing in it, is not a page", [readPage({ object: "list", data: [] }), readPage({ object: "list", data: [], has_more: true })], [null, null]);

  part("Read from Stripe: exactly what it returned, active only");
  const ok = await fresh([{ object: "list", data: [reg("taxreg_F2", { country: "DE", country_options: { de: { type: "oss_union" } } }), reg("taxreg_F1")], has_more: false }]);
  is("the two, sorted by place", ok.state === "ok" ? ok.list.map((r) => r.id) : ok.state, ["taxreg_F2", "taxreg_F1"]);
  is("asked for the active ones, a hundred a page, on the creator's account", [asked[0]?.searchParams.get("status"), asked[0]?.searchParams.get("limit")], ["active", "100"]);
  is("the link to the creator's own Locations tab (test mode here)", ok.state === "ok" ? ok.dashboard : "", "https://dashboard.stripe.com/test/tax/locations");
  is("kept half a day", [Number(redis.run(["TTL", `nl:taxreg:${ACCOUNT}`])) > TAX_REGISTRATIONS_SECONDS - 5, Number(redis.run(["TTL", `nl:taxreg:${ACCOUNT}`])) <= TAX_REGISTRATIONS_SECONDS], [true, true]);
  pages = [];
  asked = [];
  const again = await readTaxRegistrations(store);
  is("read again from the kept copy, without asking Stripe", [again.state, asked.length], ["ok", 0]);

  part("None at all is a list, said as none");
  const empty = await fresh([{ object: "list", data: [], has_more: false }]);
  is("an exact empty list is ok and empty", empty.state === "ok" ? empty.list.length : empty.state, 0);

  part("Anything else is unknown, never an empty list, and never kept");
  for (const [name, body] of [
    ["an error", null],
    ["not a list", { object: "tax.registration" }],
    ["data missing", { object: "list", has_more: false }],
    ["has_more missing", { object: "list", data: [] }],
    ["an odd row", { object: "list", data: [{ id: "taxreg_G1" }], has_more: false }],
  ] as const) {
    failing = body === null;
    const got = await fresh(body === null ? [] : [body]);
    failing = false;
    is(`${name}: unknown, nothing kept`, [got.state, redis.run(["EXISTS", `nl:taxreg:${ACCOUNT}`])], ["unknown", 0]);
  }

  part(`Paged: complete only when has_more is false, at most ${TAX_REGISTRATION_PAGES} pages`);
  const two = await fresh([
    { object: "list", data: [reg("taxreg_H1")], has_more: true },
    { object: "list", data: [reg("taxreg_H2", { country_options: { us: { state: "NY", type: "state_sales_tax" } } })], has_more: false },
  ]);
  is("two pages, the second after the first's last id", [two.state === "ok" ? two.list.length : two.state, asked[1]?.searchParams.get("starting_after")], [2, "taxreg_H1"]);
  const endless = await fresh(Array.from({ length: TAX_REGISTRATION_PAGES + 1 }, (_, i) => ({ object: "list", data: [reg(`taxreg_I${i}`)], has_more: true })));
  is("still more after the last page read: unknown, not a short list, nothing kept", [endless.state, asked.length, redis.run(["EXISTS", `nl:taxreg:${ACCOUNT}`])], ["unknown", TAX_REGISTRATION_PAGES, 0]);

  part("A kept copy that does not read back whole is not used");
  redis.clear();
  redis.run(["SET", `nl:taxreg:${ACCOUNT}`, '[{"id":"nope"}]']);
  pages = [{ object: "list", data: [reg("taxreg_J1")], has_more: false }];
  asked = [];
  const healed = await readTaxRegistrations(store);
  is("Stripe asked again, and the answer used", [asked.length, healed.state === "ok" ? healed.list[0]?.id : healed.state], [1, "taxreg_J1"]);

  part("The read names its Stripe version (Claude 4 on #2735)");
  await fresh([{ object: "list", data: [reg("taxreg_V1")], has_more: false }]);
  is("every read sends the pinned Stripe-Version", versions.length > 0 && versions.every((v) => v === STRIPE_VERSION), true);

  part("No Stripe account connected");
  is("said as none", (await readTaxRegistrations({ stripeAccountId: null })).state, "none");

  part("Places in words, never a bare code");
  is("a state, a province, a country", [placeOf({ country: "US", region: "CA" }), placeOf({ country: "CA", region: "BC" }), placeOf({ country: "DE", region: null })], ["California, United States", "British Columbia, Canada", "Germany"]);
  is("live mode links to the live Locations tab", (() => { process.env.STRIPE_SECRET_KEY = "sk_live_wg15_only"; const at = taxLocationsPage(); process.env.STRIPE_SECRET_KEY = "sk_test_wg15_only_a_stand_in"; return at; })(), "https://dashboard.stripe.com/tax/locations");

  part("The page");
  const page = readFileSync("app/studio/tax/page.tsx", "utf8");
  is("for a role with payments only", /studioView\(await cookies\(\), [^,]+, "payments"\)/.test(page), true);
  is("says what it is", page.includes("This is information from your Stripe account, not tax advice."), true);
  is("unknown is said as unknown", page.includes("We could not read this"), true);
  // Claude 4 on #2735: Stripe adds tax only when tax is on in this store's checkout (lib/tax.ts, applyTax).
  is("says tax is added only while it is on in the checkout", page.includes("Tax is on in your checkout: Stripe adds it only where you have an active registration."), true);
  is("and says none is added while it is off, even where registered", page.includes("Tax is off in your checkout, so Stripe adds none now, even where you are registered."), true);
  is("the sentence follows the store's own setting", /store\.tax\.enabled \?/.test(page), true);
  // Claude 5 on #2735: with prices that include the tax (lib/tax.ts, tax_behavior inclusive) Stripe adds nothing on top;
  // the tax comes out of the price, so the page never says "adds it" in that state.
  is(
    "with prices that include tax, says the tax comes out of the price",
    page.includes("Tax is on in your checkout and your prices include it: where you have an active registration, Stripe takes the tax out of your price."),
    true,
  );
  is("the 'adds it' sentence is only for prices without tax", /store\.tax\.included \?/.test(page), true);
  is("never says tax is added whatever the setting", page.includes("Stripe adds tax at your\n            checkout only where you have one"), false);
  // Revisor 1 on #2735: a sale paid with PayPal (lib/paypal-sales.ts) adds no tax; the page says so whenever the store sells that way.
  is("says PayPal sales carry no tax, when the store sells through PayPal", page.includes("Sales paid with PayPal have no tax added.") && /sellsThroughPayPal\(store\) \?/.test(page), true);
  is("no threshold, no coverage", /threshold|you are covered|fully covered|compliant/i.test(page), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
