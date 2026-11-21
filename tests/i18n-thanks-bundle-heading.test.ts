/**
 * The thank-you page (app/[handle]/thanks/page.tsx) after buying a bundle
 * lists what is inside it under a heading (components/bundle-delivery.tsx).
 * Every word on that page is in the store's language, except that heading:
 * the bundle bought itself was handed over without one, so the component's
 * English default, "What is inside", was drawn on a German, Spanish or any
 * other store's page. It is the store's own word for it now ("Inhalt" in
 * German), the same the list of purchases uses; English is unchanged.
 *
 * The real page over the in-memory store of the tests; only readOrder is
 * answered by tests/i18n-thanks-bundle-heading-world.ts instead of Stripe.
 */
import { renderToReadableStream } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { answerOrder } from "./i18n-thanks-bundle-heading-world";
import { ordersWords } from "@/lib/buyer-words/orders";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setLanguage, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "kueche@example.com";
const SESSION = "cs_test_i18nbundle000000000000000";
const BASE = "https://marktmorgen.com";

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;

async function open(): Promise<string> {
  answering(new Request(`${BASE}/@kueche/thanks?session_id=${SESSION}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  const tree = (await ThanksPage({ params: Promise.resolve({ handle: "@kueche" }), searchParams: Promise.resolve({ session_id: SESSION }) })) as React.ReactElement;
  const stream = await renderToReadableStream(tree, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** The heading drawn above the bundle's products: the label of the section that holds them. */
function bundleHeading(html: string): string | null {
  return /<section class="mt-6" aria-label="([^"]*)"><p class="st-label">/.exec(html)?.[1]?.replace(/&#x27;/g, "'") ?? null;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kueche", "Küche", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kueche0001", subscriptionId: "sub_kueche0001", active: true, tier: "creator", period: paidPeriod() });
  const made = await Promise.all(["Backbundle", "Brotkurs", "Rezeptheft"].map((title) => addProduct(OWNER, title, "", "29", null)));
  for (const m of made) if (!m.ok) throw new Error("no product");
  const ids = made.map((m) => (m.ok ? m.product.id : ""));
  await setProductLink(OWNER, ids[1], "https://example.com/brot");
  await setProductLink(OWNER, ids[2], "https://example.com/rezepte");

  async function orderIn(language: LanguageCode): Promise<string> {
    await setLanguage(OWNER, language);
    const store = (await storeForEmail(OWNER)) as Store;
    const [bundle, a, b] = await Promise.all(ids.map((id) => readListing(store, id)));
    if (!bundle || !a || !b) throw new Error("no listing");
    answerOrder({
      state: "paid",
      product: bundle,
      option: null,
      file: null,
      link: null,
      amount: 2900,
      email: "buyer@example.com",
      secondsLeft: 86_400,
      call: null,
      bumps: [],
      items: { items: [a, b], missing: 0 },
      created: Math.floor(Date.now() / 1000),
      upsellKey: null,
      plan: null,
      buyerKey: null,
      news: false,
      clicks: false,
      trialDays: 0,
      firstChargeAt: 0,
      endsAfter: 0,
      answers: [],
      record: { id: SESSION, metadata: {} },
      membership: null,
      reference: SESSION,
      gift: null,
      group: null,
      preorder: false,
      currency: "usd",
      reusable: false,
    } as never);
    return open();
  }

  part("English: the heading is as it was (control)");
  const en = await orderIn("en");
  is("the bundle's products are listed", [en.includes("Brotkurs"), en.includes("Rezeptheft")], [true, true]);
  is("under the English heading", bundleHeading(en), "What is inside");

  part("Every other language: the heading is in the store's language");
  for (const code of LANGUAGE_CODES) {
    if (code === "en") continue;
    const html = await orderIn(code);
    is(`${code}: the page is marked with the store's language`, html.includes(`lang="${LANGUAGES[code].locale}"`), true);
    is(`${code}: the bundle's products are listed`, [html.includes("Brotkurs"), html.includes("Rezeptheft")], [true, true]);
    is(`${code}: the heading is not the English one`, html.includes("What is inside"), false);
    is(`${code}: it is the store's own word for it`, bundleHeading(html), ordersWords(code).whatIsInside);
  }
  done();
}

void main();
