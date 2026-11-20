/**
 * Sweep app1, finding 7: the store's currency is changed only to one the
 * creator's Stripe account can charge in. When Stripe cannot be asked (the
 * account read fails, or answers no country or no list of currencies),
 * `chargeableCurrencies` answers null, and null is "not known", never "any
 * currency": the route refuses ("unavailable", 503) and nothing is saved, so
 * the creator is never told the store charges in a currency every checkout
 * would then fail in. Through the real route, on synthetic stores, with a
 * stand-in for Stripe's `fetch` and the memory stand-in for Redis; nothing
 * real is reached.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStoreId, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as currencyRoute } from "@/app/api/store/currency/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_currency_null";

const ACCOUNT = "acct_1TestCurNull001";
let account: "ok" | "down" | "no_country" = "ok";
let spec: "ok" | "empty" | "down" | "malformed" = "ok";
let accountReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/account") {
    accountReads += 1;
    if (account === "down") return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 503 });
    return new Response(JSON.stringify(account === "no_country" ? { id: ACCOUNT } : { id: ACCOUNT, country: "US" }));
  }
  if (path === "/country_specs/US") {
    if (spec === "down") return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 503 });
    // "malformed": an entry that is not text, beside one that is (review rv36 on #2993).
    const list = spec === "empty" ? [] : spec === "malformed" ? ["cad", null] : ["usd", "cad"];
    return new Response(JSON.stringify({ id: "US", supported_payment_currencies: list }));
  }
  if (path === "/subscriptions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

/** Forgets the kept list of the account's currencies, so the next change asks Stripe again. */
async function forgetKept(): Promise<void> {
  for (const key of redis.keys().filter((k: string) => k.includes(ACCOUNT))) await redis.pipeline([["DEL", key]]);
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "currencynull@example.com";
  await claimHandle(owner, "currencynull", "Currency Null", "");
  await ensureStoreId(owner);
  await setStripeAccount(owner, ACCOUNT, true);
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await currencyRoute(new NextRequest("https://marktmorgen.com/api/store/currency", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const currency = async () => (await storeForEmail(owner))!.currency;

  part("Stripe answers: a currency the account cannot charge is refused, one it can is saved");
  const unsupported = await post({ currency: "eur" });
  is("eur on an account that charges usd and cad: unsupported", [unsupported.status, unsupported.body.error], [400, "unsupported"]);
  is("the store stays in usd", await currency(), "usd");

  for (const [label, set] of [
    ["the account read fails", () => { account = "down"; }],
    ["the account answers no country", () => { account = "no_country"; }],
    ["the country's list of currencies fails", () => { spec = "down"; }],
    ["the country's list of currencies is empty", () => { spec = "empty"; }],
  ] as const) {
    part(`Stripe not known: ${label}`);
    await forgetKept();
    set();
    const refused = await post({ currency: "eur" });
    account = "ok";
    spec = "ok";
    is(`${label}: refused as not known (503 unavailable), never saved`, [refused.status, refused.body.ok, refused.body.error], [503, false, "unavailable"]);
    is(`${label}: the store stays in usd`, await currency(), "usd");
  }

  part("Stripe answers again");
  await forgetKept();
  const cad = await post({ currency: "cad" });
  is("cad, which the account charges, is saved", [cad.status, cad.body.ok], [200, true]);
  is("the store now charges in cad", await currency(), "cad");
  const eur = await post({ currency: "eur" });
  is("eur from the kept list: still unsupported", [eur.status, eur.body.error], [400, "unsupported"]);
  is("the store stays in cad", await currency(), "cad");

  part("Stripe's list holds an entry that is not text (review rv36 on #2993)");
  await forgetKept();
  spec = "malformed";
  const partial = await post({ currency: "usd" });
  spec = "ok";
  is("usd, with Stripe's list [cad, null]: refused as not known (503 unavailable), never 400 unsupported", [partial.status, partial.body.error], [503, "unavailable"]);
  is("the store stays in cad", await currency(), "cad");
  is("the shortened list is not kept", (await redis.pipeline([["GET", `nl:pay:currencies:${ACCOUNT}`]]))[0], null);
  const whole = await post({ currency: "usd" });
  is("once Stripe answers the whole list, usd is saved (nothing shortened was kept for 12 hours)", [whole.status, whole.body.ok], [200, true]);
  is("the store now charges in usd", await currency(), "usd");

  // Each case asks for the currency the store is not in, both of which the account charges:
  // "OK" would read as no currency at all, and "<current>,zzz" as the current one alone.
  for (const [label, keptOf] of [
    ["a reply that is not a list of currencies (\"OK\")", () => "OK"],
    ["a list with a code that is not a store currency", (current: string) => `${current},zzz`],
  ] as const) {
    part(`The kept list reads back in an unknown shape: ${label} (Claude 3's review on #2993)`);
    const current = await currency();
    const wanted = current === "cad" ? "usd" : "cad";
    await forgetKept();
    await redis.pipeline([["SET", `nl:pay:currencies:${ACCOUNT}`, keptOf(current)]]);
    const reads = accountReads;
    const asked = await post({ currency: wanted });
    is(`${label}: ${wanted}, which the account charges, is saved, never 400 unsupported`, [asked.status, asked.body.ok, asked.body.error], [200, true, undefined]);
    is(`${label}: Stripe was asked again`, accountReads > reads, true);
    is(`${label}: the store now charges in ${wanted}`, await currency(), wanted);
  }
  done();
}
main();
