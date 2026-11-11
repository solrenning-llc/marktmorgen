/**
 * 251 [ST4], unit 1: from sign-up to a store ready to sell, measured.
 *
 * One new creator walks the real routes, in order, on the in-memory Redis,
 * with the email provider and Stripe simulated (nothing real is called):
 *
 *   1. asks for a sign-in link with an email address;
 *   2. opens it (the one-tap confirm form);
 *   3. claims a store with an address (a name is optional);
 *   4. adds a first product with a title and a price;
 *   5. starts Stripe's onboarding with a country;
 *   6. asks for a plan, which turns the checkout on.
 *
 * Each step counts as one action of the person, and each field the route
 * refuses to go on without counts as one required field: the walk proves a
 * field is required by sending the same request without it and seeing it
 * refused. What the walk measured is compared with the record
 * docs/signup-to-ready-measured.md, so the record cannot drift from the code.
 *
 * It does not measure a person's time (that needs real people, item 202) and
 * it never opens selling: with PLANS_ON_SALE false the walk ends at step 6,
 * refused with billing=not-open, and the store cannot sell (canSell false).
 */
import { readFileSync, existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as askLink } from "@/app/api/auth/request/route";
import { POST as openLink } from "@/app/api/auth/callback/route";
import { POST as claim } from "@/app/api/store/claim/route";
import { POST as product } from "@/app/api/store/product/route";
import { POST as connect } from "@/app/api/stripe/connect/route";
import { POST as plan } from "@/app/api/billing/checkout/route";
import { SESSION_COOKIE } from "@/lib/auth";
import { storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { canSell } from "@/lib/store-checkout";
import { PLANS_ON_SALE } from "@/lib/opening";
import { store as redis } from "./redis-stub";
import { installSesMailFixture } from "./ses-mail-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_signup_walk_only_a_stand_in";

const ORIGIN = "https://marktmorgen.com";
const stripeCalls: string[] = [];
globalThis.fetch = (async () => { throw new Error("No real provider in this walk"); }) as typeof fetch;
// The email provider (Amazon SES) simulated, its mail kept here; Stripe simulated by the fallback.
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.stripe.com/")) return new Response("{}", { status: 404 });
    stripeCalls.push(url.replace(/^https:\/\/api\.stripe\.com/, ""));
    if (url.includes("/v2/core/accounts")) return Response.json({ id: "acct_1WalkTest" });
    if (url.includes("/account_links")) return Response.json({ url: "https://connect.stripe.com/setup/e/acct_1WalkTest/walk" });
    return new Response("{}", { status: 404 });
  },
});
mail.configure();

const EMAIL = "walker@example.com";
let session = "";
const sameSite = () => ({ origin: ORIGIN, host: "marktmorgen.com", "sec-fetch-site": "same-origin" });
const asJson = (url: string, body: unknown, withSession = false) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...sameSite(), ...(withSession ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) },
    body: JSON.stringify(body),
  });
const asForm = (url: string, fields: Record<string, string>, withSession = false) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...sameSite(), ...(withSession ? { cookie: `${SESSION_COOKIE}=${session}` } : {}) },
    body: new URLSearchParams(fields),
  });
const where = (response: Response) => response.headers.get("location") ?? "";

/** One measured step: what the person does, and the fields the route will not go on without. */
type Step = { step: number; action: string; required: string[] };
const walk: Step[] = [];

async function main(): Promise<void> {
  redis.clear();

  part("1. Ask for a sign-in link");
  is("without an email address: refused", (await askLink(asJson(`${ORIGIN}/api/auth/request`, { website: "" }))).status, 400);
  const asked = await askLink(asJson(`${ORIGIN}/api/auth/request`, { email: EMAIL, website: "" }));
  is("with one: asked", asked.status, 200);
  const link = /https:\/\/marktmorgen\.com\/signin\/confirm\?\S+/.exec(mail.sent.at(-1)?.text ?? "")?.[0] ?? "";
  const token = link ? new URL(link).searchParams.get("token") ?? "" : "";
  is("the email carries a one-time link", /^[0-9a-f]{64}$/.test(token), true);
  walk.push({ step: 1, action: "Ask for a sign-in link", required: ["email"] });

  part("2. Open the link");
  const opened = await openLink(asForm(`${ORIGIN}/api/auth/callback`, { token }));
  session = /nl_session=([0-9a-f]{64})/.exec(opened.headers.get("set-cookie") ?? "")?.[1] ?? "";
  is("signed in, sent to the studio", [where(opened), session.length], [`${ORIGIN}/studio`, 64]);
  is("the link works once", where(await openLink(asForm(`${ORIGIN}/api/auth/callback`, { token }))) === `${ORIGIN}/studio`, false);
  walk.push({ step: 2, action: "Open the link and confirm", required: [] });

  part("3. Claim the store");
  const claimUrl = `${ORIGIN}/api/store/claim`;
  is("without an address: refused", (await claim(asJson(claimUrl, { name: "Walker Goods" }, true))).ok, false);
  const claimed = await claim(asJson(claimUrl, { handle: "walkergoods" }, true));
  is("with the address alone: claimed (the name is optional)", claimed.status, 200);
  is("the account has its store", (await storeForEmail(EMAIL))?.handle, "walkergoods");
  walk.push({ step: 3, action: "Claim the store", required: ["handle"] });

  part("4. Add the first product");
  const productUrl = `${ORIGIN}/api/store/product`;
  is("without a title: refused", (await product(asJson(productUrl, { action: "add", price: "19" }, true))).ok, false);
  is("without a price: refused", (await product(asJson(productUrl, { action: "add", title: "Field notes" }, true))).ok, false);
  const added = await product(asJson(productUrl, { action: "add", title: "Field notes", price: "19" }, true));
  is("with both: added", added.status, 200);
  const store = await storeForEmail(EMAIL);
  const productId = store?.products?.[0] ?? "";
  is("published at once: no separate publish step", (await readListing(store!, productId))?.hidden === true, false);
  walk.push({ step: 4, action: "Add the first product", required: ["title", "price"] });

  part("5. Start Stripe's onboarding");
  const connectUrl = `${ORIGIN}/api/stripe/connect`;
  is("without a country: asked for it", where(await connect(asForm(connectUrl, {}, true))).includes("stripe=country"), true);
  const started = await connect(asForm(connectUrl, { country: "US" }, true));
  is("with one: sent to Stripe's own pages", where(started), "https://connect.stripe.com/setup/e/acct_1WalkTest/walk");
  is("only the account and its link were asked of Stripe", stripeCalls.map((call) => call.split("?")[0]), ["/v2/core/accounts", "/v2/core/account_links"]);
  walk.push({ step: 5, action: "Start Stripe's onboarding", required: ["country"] });

  part("6. Turn the checkout on");
  const planned = await plan(asForm(`${ORIGIN}/api/billing/checkout`, { tier: "creator" }, true));
  is("closed while plans are not on sale", [PLANS_ON_SALE, where(planned).includes("billing=not-open")], [false, true]);
  is("so the store cannot sell", canSell((await storeForEmail(EMAIL))!), false);
  // Its fields cannot be measured: the route refuses before it reads them.
  walk.push({ step: 6, action: "Choose a plan (closed today)", required: [] });

  part("The record matches the walk");
  const recordPath = "docs/signup-to-ready-measured.md";
  is("the record exists", existsSync(recordPath), true);
  const record = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
  const rows = [...record.matchAll(/^\| (\d) \| ([^|]+) \| ([^|]+) \|/gm)].map((row) => ({
    step: Number(row[1]),
    action: row[2].trim(),
    required: row[3].trim() === "none" ? [] : row[3].split(",").map((field) => field.trim().replace(/`/g, "")),
  }));
  is("one row per step, with its action and required fields", rows, walk);
  const fields = walk.reduce((sum, step) => sum + step.required.length, 0);
  is("the totals it states", [record.includes(`**${walk.length} actions**`), record.includes(`**${fields} required fields**`)], [true, true]);
  is("it says selling stays closed and no person's time was measured", [/PLANS_ON_SALE/.test(record), /not measured/i.test(record)], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
