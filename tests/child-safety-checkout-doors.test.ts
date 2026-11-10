/**
 * Every door that opens a single product's checkout refuses one that would
 * hand over a product kept for a child-safety report (lib/child-safety.ts,
 * C1-20261109-1546-TODOS-70). Claude 6's focal reviews of #3471 (6757630267,
 * 6758076515) found that a welcome offer on a bundle holding the held product
 * still named it in the email and opened a Stripe checkout for it: openWelcome
 * (lib/welcome-offer-send.ts) called createCheckout (lib/store-checkout.ts)
 * directly, and only the checkout route asked heldInSale first.
 *
 * Held here:
 *   - the welcome offer on such a bundle is not offered (welcomeFor) and its
 *     button opens nothing at Stripe (openWelcome); a hold that cannot be
 *     read refuses too (rule 24); a bundle not held is still offered;
 *   - no file but lib/held-checkout.ts calls createCheckout, so every door
 *     (the checkout route, the welcome offer, the come-back offer, a moved
 *     member's checkout, and any added later) passes the same check before a
 *     checkout is built.
 *
 * Nobody opens, downloads or describes reported content: the titles are
 * neutral placeholders and the products hand over a placeholder link.
 * Synthetic store, in-memory Redis, every outside call caught here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, storeForEmail } from "@/lib/store";
import * as safety from "@/lib/child-safety";
import { readListing } from "@/lib/catalog";
import { readClaimFull, requestCopy } from "@/lib/free";
import { openWelcome, welcomeFor } from "@/lib/welcome-offer-send";
import { store as redis } from "./redis-stub";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
process.env.STRIPE_SECRET_KEY = "sk_test_held_doors_only_a_stand_in";

const sent: string[] = [];
const opened: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
    return json({ id: "email_held_doors" });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    opened.push(new URLSearchParams(String(init.body)));
    return json({ id: `cs_test_${"d".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/held-doors" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "hold.doors@example.com";
const HANDLE = "holddoors";
const ORIGIN = "https://marktmorgen.com";

/** Source files of the app and its library, for the one-door check. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Hold Doors", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHoldDoors01", true);
  await setSubscription(OWNER, { customerId: "cus_holddoors", subscriptionId: "sub_holddoors", active: true, period: paidPeriod() });
  const current = async () => (await storeForEmail(OWNER))!;
  const make = async (title: string, price: string, link = true) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error("no product");
    if (link) await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const ask = async (email: string, productId: string) => {
    const store = await current();
    const before = sent.length;
    const result = await requestCopy({ store, product: (await readListing(store, productId))!, email, consent: true, ip: `10.0.1.${sent.length}`, origin: ORIGIN });
    if (result !== "sent") throw new Error(`not sent: ${result}`);
    return /token=([0-9a-f]{64})/.exec(sent[before])?.[1] ?? "";
  };
  const names = (body: URLSearchParams, id: string) => [...body.values()].some((value) => value.split(",").includes(id));

  // As a creator had set it up before the report: a free guide, and a welcome offer on a bundle.
  const reported = await make("reported-item-part", "19");
  const partB = await make("item-part-b", "19");
  const partC = await make("item-part-c", "19");
  const partD = await make("item-part-d", "19");
  const heldBundle = await make("item-bundle-with-reported", "29", false);
  const cleanBundle = await make("item-bundle-clean", "29", false);
  for (const [bundle, items] of [
    [heldBundle, [reported, partB]],
    [cleanBundle, [partC, partD]],
  ] as const) {
    const saved = await setProductBundle(OWNER, bundle, [...items]);
    if (!saved.ok) throw new Error(`bundle not saved: ${saved.reason}`);
  }
  const free = await make("item-free-guide", "0");
  await setWelcomeOffer(OWNER, { product: heldBundle, percent: 25, hours: 48, coupon: "c_welcome25", remind: false, address: "" });
  const token = await ask("lead@example.com", free);
  const claim = (await readClaimFull(token))!;
  const asked = Math.floor(Date.parse(claim.at) / 1000);

  part("Before the report: the welcome offer on the bundle opens");
  is("offered", (await welcomeFor(await current(), claim, asked + 60))?.product.id, heldBundle);
  const before = await openWelcome(await current(), token, ORIGIN, asked + 60, TEST_CONSENT);
  is("its button opens a checkout naming both products", [before.ok, names(opened.at(-1)!, reported), names(opened.at(-1)!, partB)], [true, true, true]);

  // The report.
  const outcome = await safety.holdReported({ kind: "child_safety", url: `${ORIGIN}/@${HANDLE}/p/${reported}` }, await current());
  if (outcome !== "held") throw new Error(`not held: ${outcome}`);
  const openedAt = opened.length;

  part("After the report: the welcome offer on a bundle holding the held product");
  is("is no longer offered (the email and the page read welcomeFor)", await welcomeFor(await current(), claim, asked + 120), null);
  const after = await openWelcome(await current(), token, ORIGIN, asked + 120, TEST_CONSENT);
  is("its button opens nothing", after, { ok: false, reason: "unavailable" });
  is("nothing reached Stripe", opened.length - openedAt, 0);

  part("A hold that cannot be read refuses (rule 24)");
  await setWelcomeOffer(OWNER, { product: cleanBundle, percent: 25, hours: 48, coupon: "c_welcome25", remind: false, address: "" });
  is("the clean bundle is offered", (await welcomeFor(await current(), claim, asked + 180))?.product.id, cleanBundle);
  const store = await current();
  const tag = store.statsId || `h:${store.handle}`;
  await redis.pipeline([["SET", `nl:csa:keep:${tag}:${partC}`, "garbled"]]);
  is("an unreadable hold: not offered", await welcomeFor(await current(), claim, asked + 180), null);
  is("an unreadable hold: its button opens nothing", (await openWelcome(await current(), token, ORIGIN, asked + 180, TEST_CONSENT)).ok, false);
  is("nothing reached Stripe", opened.length - openedAt, 0);
  await redis.pipeline([["DEL", `nl:csa:keep:${tag}:${partC}`]]);

  part("A bundle not held still sells through the welcome offer");
  const clean = await openWelcome(await current(), token, ORIGIN, asked + 240, TEST_CONSENT);
  is("its button opens a checkout naming both", [clean.ok, names(opened.at(-1)!, partC), names(opened.at(-1)!, partD)], [true, true, true]);
  is("no checkout since the report names the held product", opened.slice(openedAt).some((body) => names(body, reported)), false);

  part("One door to a single product's checkout");
  const root = process.cwd();
  const callers = [...sources(join(root, "app")), ...sources(join(root, "lib"))]
    .map((path) => relative(root, path))
    .filter((path) => path !== "lib/store-checkout.ts" && path !== "lib/held-checkout.ts")
    // Code only: a comment may name it.
    .filter((path) => /\bcreateCheckout\b/.test(readFileSync(join(root, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")));
  is("no file but lib/held-checkout.ts calls createCheckout", callers, []);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
