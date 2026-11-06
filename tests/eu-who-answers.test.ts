/**
 * Who answers for what, said to the buyer before paying (Directive 2011/83/EU
 * art. 6a(1)(d), as amended by Directive (EU) 2019/2161: "where applicable,
 * how the obligations related to the contract are shared between the third
 * party offering the goods, services or digital content and the provider of
 * the online marketplace"). The Terms (app/terms/page.tsx, section 3) make the
 * creator the seller, say each sale is a contract between the creator and the
 * buyer and that Marktmorgen "is not a party to it", and leave the product,
 * answering buyers, refunds and any refund on a cancellation to the creator;
 * the Refund Policy (app/refunds/page.tsx, section 7) says the same to buyers.
 * The sentence says no more than that: Marktmorgen hosts the store's pages
 * (payment itself is on Stripe's or PayPal's own page, on the creator's
 * account) and is not a party to the sale, which is a contract-law fact and
 * leaves room for the role EU VAT art. 9a gives Marktmorgen for tax
 * (docs/eu-vat-article-9a.md). Checked, on synthetic records only, with no
 * network:
 *
 *   - the product page, drawn as a browser gets it, says that sentence in
 *     every store language;
 *   - every other page where a buyer starts paying draws it too: the store
 *     page, a collection, the booking page, the renewal page, a course's
 *     front door and a payment request;
 *   - it is not drawn where nothing can be paid for now: in test mode, on the
 *     demo store, for a free product, in a store that cannot take payments,
 *     or on a booking page whose calendar is closed;
 *   - the embedded card's pages draw it where a buyer starts paying;
 *   - the card in a frame, whose button goes straight to paying (a product
 *     that is shipped, with nothing digital), has no room for the whole
 *     sentence, so it says a short one of its own in every store language,
 *     never cut: the card scrolls inside the frame rather than clip it. The
 *     product's title still leads to its page, where the whole sentence is.
 */
import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import StorePage from "@/app/[handle]/page";
import BookPage from "@/app/[handle]/book/[product]/page";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import CoursePage from "@/app/[handle]/course/[product]/page";
import PaymentRequestPage from "@/app/[handle]/pay/[request]/page";
import CollectionPage from "@/app/[handle]/shop/[collection]/page";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  setCollections,
  setLanguage,
  setProductCall,
  setProductCourse,
  setProductLink,
  setProductShipping,
  setEmbedSites,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import { saveCourse, type Course } from "@/lib/course";
import { createRequest } from "@/lib/payment-request-store";
import { collectionSegment } from "@/lib/store-collections";
import { HOUSE_OWNER } from "@/lib/house-store";
import type { CallSetup } from "@/lib/call-setup";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const OWNER = "harbor@example.com";
const STORE = "Harbor Kitchen";

/** The sentence, word for word, in each store language. */
const SAID: Record<LanguageCode, string> = {
  en: `${STORE} is the seller and is responsible for what you buy, for refunds and for any right you have to cancel. Marktmorgen hosts the store's pages and is not a party to the sale.`,
  es: `${STORE} es quien vende y responde de lo que compras, de los reembolsos y de cualquier derecho de desistimiento que tengas. Marktmorgen aloja las páginas de la tienda y no es parte en la venta.`,
  fr: `${STORE} est le vendeur et répond de ce que vous achetez, des remboursements et de tout droit de rétractation dont vous disposez. Marktmorgen héberge les pages de la boutique et n'est pas partie à la vente.`,
  de: `${STORE} ist der Verkäufer und verantwortlich für das, was Sie kaufen, für Erstattungen und für ein etwaiges Widerrufsrecht. Marktmorgen stellt die Seiten des Shops bereit und ist nicht Partei des Kaufvertrags.`,
  it: `${STORE} è il venditore e risponde di ciò che compri, dei rimborsi e dell'eventuale diritto di recesso. Marktmorgen ospita le pagine del negozio e non è parte del contratto di vendita.`,
  nl: `${STORE} is de verkoper en is verantwoordelijk voor wat je koopt, voor terugbetalingen en voor een eventueel herroepingsrecht. Marktmorgen host de pagina's van de winkel en is geen partij bij de verkoop.`,
  pt: `${STORE} é o vendedor e responde pelo que compra, pelos reembolsos e por qualquer direito de livre resolução que tenha. A Marktmorgen aloja as páginas da loja e não é parte na venda.`,
};

/** The short sentence the card in a frame says, word for word, in each store language. */
const SHORT: Record<LanguageCode, string> = {
  en: `Sold by ${STORE}, who is responsible for it.`,
  es: `Lo vende ${STORE}, que responde de lo que compras.`,
  fr: `Vendu par ${STORE}, qui en est responsable.`,
  de: `${STORE} ist der Verkäufer und dafür verantwortlich.`,
  it: `Venduto da ${STORE}, che ne risponde.`,
  nl: `Verkocht door ${STORE}, die ervoor verantwoordelijk is.`,
  pt: `Vendido por ${STORE}, que responde pelo que compra.`,
};

/**
 * Words the sentence must never say again: that Marktmorgen is no part of the
 * sale at all (wider than the Terms, and against EU VAT art. 9a once it is
 * built), that it hosts the checkout or the payment page (payment is on
 * Stripe's or PayPal's own page), and the idiom "answers for" (AX274, 3.1.5).
 */
const NEVER = [
  "not part of the sale",
  "answers for",
  "checkout",
  "no es parte de la venta",
  "página de pago",
  "page de paiement",
  "Bezahlvorgang",
  "non è parte della vendita",
  "pagina di pagamento",
  "ogni diritto di recesso che hai",
  "betaalpagina",
  "página de pagamento",
];

/** No call leaves the test: every request is recorded and answered with an empty list. */
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  calls.push(new URL(String(input instanceof Request ? input.url : input)).hostname);
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Drops every match of `pattern` until none is left, so a match cut in two cannot rebuild one. */
function stripAll(text: string, pattern: RegExp): string {
  let before: string;
  let after = text;
  do {
    before = after;
    after = before.replace(pattern, "");
  } while (after !== before);
  return after;
}

/** The page's text as a reader gets it: comments and tags dropped, entities read back. */
function textOf(html: string): string {
  return stripAll(stripAll(html, /<!--[\s\S]*?-->/g), /<[^>]*>/g)
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** A page drawn as a browser gets it, as its markup. */
async function markup(url: string, run: () => Promise<unknown>, init?: RequestInit): Promise<string> {
  answering(new Request(url, init));
  const node = await run();
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** A page drawn as a browser gets it, as its text. */
async function drawn(url: string, run: () => Promise<unknown>): Promise<string> {
  return textOf(await markup(url, run));
}

/** The embedded card for a product, as its frame draws it; `query` as the code that opened it put it on the address. */
const cardHtml = (handle: string, product: string, query: Record<string, string> = {}, referer?: string) => {
  const search = new URLSearchParams(query).toString();
  return markup(
    `https://marktmorgen.com/embed/${handle}/${product}${search ? `?${search}` : ""}`,
    () => EmbedCard({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve(query) } as Parameters<typeof EmbedCard>[0]),
    referer ? { headers: { referer } } : undefined,
  );
};

/** The opening tag of the element whose own text is exactly `words`, or "" when there is none. */
function holding(html: string, words: string): string {
  const at = html.indexOf(`>${words.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")}<`);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<", at), at + 1);
}

const productPage = (handle: string, product: string) =>
  drawn(`https://marktmorgen.com/@${handle}/p/${product}`, () =>
    ProductPage({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve({}) } as Parameters<typeof ProductPage>[0]),
  );
const storePage = (handle: string) =>
  drawn(`https://marktmorgen.com/@${handle}`, () => StorePage({ params: Promise.resolve({ handle: `@${handle}` }), searchParams: Promise.resolve({}) } as Parameters<typeof StorePage>[0]));
const bookPage = (handle: string, product: string) =>
  drawn(`https://marktmorgen.com/@${handle}/book/${product}`, () =>
    BookPage({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve({}) } as Parameters<typeof BookPage>[0]),
  );
const renewPage = (handle: string, product: string) =>
  drawn(`https://marktmorgen.com/@${handle}/renew/${product}`, () =>
    RenewPage({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve({}) } as Parameters<typeof RenewPage>[0]),
  );

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const CALL = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

/** A store with a paid plan, a product delivered by link and a weekly call; taking payments when `stripe` is set. */
async function makeStore(email: string, handle: string, stripe: string | null): Promise<{ store: Store; product: string; call: string }> {
  const made = await claimHandle(email, handle, STORE, "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(email);
  await ensureStoreId(email);
  if (stripe) await setStripeAccount(email, stripe, true);
  await setSubscription(email, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const added = await addProduct(email, "Meal Planner", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(email, added.product.id, "https://example.com/planner");
  const call = await addProduct(email, "Kitchen call", "", "45", null);
  if (!call.ok) throw new Error("no call");
  await setProductCall(email, call.product.id, CALL);
  return { store: (await storeForEmail(email)) as Store, product: added.product.id, call: call.product.id };
}

async function main(): Promise<void> {
  redis.clear();
  // A key of the live shape so the page is not in Stripe's test mode; no request reaches Stripe (fetch above).
  process.env.STRIPE_SECRET_KEY = "sk_live_eu_who_answers_stand_in";
  const harbor = await makeStore(OWNER, "harbor", "acct_1TestEuWhoAns1");

  part("The sentence, in every store language");
  for (const code of LANGUAGE_CODES) {
    const said = wordsIn(code).whoAnswers(STORE);
    is(`${code}: word for word`, said, SAID[code]);
    is(`${code}: never wider than the Terms, never a checkout or payment page it does not host`, NEVER.filter((words) => said.includes(words)), []);
  }
  const first = SAID.en.split(". ")[0];
  is("en: the first sentence is short (AX274, 3.1.5)", first.split(" ").length <= 22, true);

  part("The product page, before paying, in every store language");
  const before = calls.length;
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    const text = await productPage("harbor", harbor.product);
    is(`${code}: the line on who takes the payment is drawn`, text.includes(wordsIn(code).paidBy("Stripe", STORE)), true);
    is(`${code}: who answers for what, word for word`, text.includes(SAID[code]), true);
  }
  await setLanguage(OWNER, "en");
  const fromProductPages = calls.slice(before);

  part("Every other page where a buyer starts paying");
  is("the store page", (await storePage("harbor")).includes(SAID.en), true);
  is("the booking page, with its calendar open", (await bookPage("harbor", harbor.call)).includes(SAID.en), true);
  is("the renewal page", (await renewPage("harbor", harbor.product)).includes(SAID.en), true);

  const saved = await setCollections(OWNER, [{ title: "Planning", products: [harbor.product] }]);
  if (!saved.ok) throw new Error("no collection");
  const collection = ((await storeForEmail(OWNER)) as Store).collections![0];
  const segment = collectionSegment(collection);
  const shop = await drawn(`https://marktmorgen.com/@harbor/shop/${segment}`, () =>
    CollectionPage({ params: Promise.resolve({ handle: "@harbor", collection: segment }) } as Parameters<typeof CollectionPage>[0]),
  );
  is("a collection", shop.includes(SAID.en), true);

  const course = await addProduct(OWNER, "Knife skills", "", "79", null);
  if (!course.ok) throw new Error("no course product");
  const lessons: Course = {
    id: "e".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [{ id: "module000001", title: "Basics", dripDays: 0, lessons: [{ id: "lesson000001", title: "Holding the knife", preview: false, video: null, files: [], link: null, hasBody: false, quiz: null }] }],
  } as unknown as Course;
  await saveCourse(lessons, ROOM, true);
  const attached = await setProductCourse(OWNER, course.product.id, { id: lessons.id, lessons: 1 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const front = await drawn(`https://marktmorgen.com/@harbor/course/${course.product.id}`, () =>
    CoursePage({ params: Promise.resolve({ handle: "@harbor", product: course.product.id }), searchParams: Promise.resolve({}) } as Parameters<typeof CoursePage>[0]),
  );
  is("a course's front door", front.includes(SAID.en), true);

  const asked = await createRequest((await storeForEmail(OWNER)) as Store, { email: "buyer@example.com", name: "Sam", lines: [{ text: "Menu plan", quantity: 1, cents: 5000 }], note: "", dueDate: "", autoReminders: 0, total: 5000 } as Parameters<typeof createRequest>[1]);
  if (!asked.ok) throw new Error(`no request: ${asked.reason}`);
  const request = await drawn(`https://marktmorgen.com/@harbor/pay/${asked.request.id}`, () =>
    PaymentRequestPage({ params: Promise.resolve({ handle: "@harbor", request: asked.request.id }), searchParams: Promise.resolve({}) } as Parameters<typeof PaymentRequestPage>[0]),
  );
  is("a payment request", request.includes(SAID.en), true);

  part("Not drawn where nothing can be paid for now");
  // Whatever the sentence says today, so a page that draws it where it must not fails here whatever its words.
  const said = wordsIn("en").whoAnswers(STORE);
  const free = await addProduct(OWNER, "Free shopping list", "", "0", null);
  if (!free.ok) throw new Error("no free product");
  await setProductLink(OWNER, free.product.id, "https://example.com/list");
  is("a free product", (await productPage("harbor", free.product.id)).includes(said), false);

  const shut = await makeStore("closed@example.com", "closedkitchen", null);
  is("a store that cannot take payments: the store page", (await storePage("closedkitchen")).includes(said), false);
  is("a store that cannot take payments: the product page", (await productPage("closedkitchen", shut.product)).includes(said), false);
  is("a booking page whose calendar is closed", (await bookPage("closedkitchen", shut.call)).includes(said), false);

  const demo = await makeStore(HOUSE_OWNER, "demokitchen", "acct_1TestEuWhoDemo");
  is("the demo store's booking page", (await bookPage("demokitchen", demo.call)).includes(said), false);
  is("the demo store's renewal page", (await renewPage("demokitchen", demo.product)).includes(said), false);

  process.env.STRIPE_SECRET_KEY = "sk_test_eu_who_answers_stand_in";
  is("test mode: the product page", (await productPage("harbor", harbor.product)).includes(said), false);
  is("test mode: the booking page", (await bookPage("harbor", harbor.call)).includes(said), false);
  is("test mode: the renewal page", (await renewPage("harbor", harbor.product)).includes(said), false);
  process.env.STRIPE_SECRET_KEY = "sk_live_eu_who_answers_stand_in";

  part("The embedded card's pages, where a buyer starts paying");
  // Read from the source: the card's pages need the creator's listed site and the checkout script to open.
  const embed = readFileSync("app/embed/[handle]/[product]/page.tsx", "utf8");
  const times = embed.slice(embed.indexOf('query.view === "times"'), embed.indexOf("const testMode = selling"));
  is("the call's times, drawn in the frame", times.includes("<WhoAnswers store={store}"), true);
  const asPage = embed.slice(embed.indexOf('if (open?.mode === "page") {\n    return'));
  is("the card opened as a page of its own", asPage.slice(0, asPage.indexOf("\n  }\n")).includes("<WhoAnswers store={store}"), true);

  part("The card in a frame, paid straight from its button: a shipped product");
  const pan = await addProduct(OWNER, "Cast iron pan", "Seasoned and ready to cook on, shipped in a week.", "59", null);
  if (!pan.ok) throw new Error("no shipped product");
  const shipped = await setProductShipping(OWNER, pan.product.id, { cents: 0, region: "us", countries: ["US"], note: "" });
  if (!shipped.ok) throw new Error(`not shipped: ${shipped.reason}`);
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    is(`${code}: the short sentence, word for word`, wordsIn(code).cardSoldBy(STORE), SHORT[code]);
    is(`${code}: never wider than the Terms`, NEVER.filter((words) => SHORT[code].includes(words)), []);
    const html = await cardHtml("harbor", pan.product.id);
    is(`${code}: pasted in a frame, the button still goes straight to paying`, html.includes('action="/api/store/checkout"'), true);
    is(`${code}: and the card says the short sentence`, textOf(html).includes(SHORT[code]), true);
    const tag = holding(html, SHORT[code]);
    is(`${code}: on a line that wraps, never cut short`, [tag !== "", /\btruncate\b|line-clamp|text-ellipsis/.test(tag)], [true, false]);
    // Claude 5 on #3019: the note under the button ("Secure checkout by Stripe, in a new tab.") is never cut either.
    const noteTag = holding(html, wordsIn(code).cardCheckout);
    is(`${code}: the checkout note under the button wraps too, never cut short`, [noteTag !== "", /\btruncate\b|line-clamp|text-ellipsis/.test(noteTag)], [true, false]);
  }
  await setLanguage(OWNER, "en");
  const pasted = await cardHtml("harbor", pan.product.id);
  is("a card that does not fit its frame scrolls inside it, so the sentence is never clipped", [/<div[^>]*class="[^"]*\boverflow-y-auto\b[^"]*"[^>]*data-card-height=/.test(pasted), /<article class="st-card [^"]*\bmin-h-full\b/.test(pasted)], [true, true]);
  is("the product's title still leads to its own page, where the whole sentence is", new RegExp(`<h1[^>]*><a href="/@harbor/p/[^"?]*${pan.product.id}\\?utm_source=website&amp;utm_medium=buy-button"`).test(pasted), true);

  const listed = await setEmbedSites(OWNER, "https://www.example.com");
  if (!listed.ok) throw new Error("no listed site");
  const overlay = await cardHtml("harbor", pan.product.id, { mm: "overlay" }, "https://www.example.com/shop");
  is("opened by the checkout script over a listed site: paid straight from its button, with the short sentence", [overlay.includes('action="/api/store/checkout"'), textOf(overlay).includes(SHORT.en)], [true, true]);
  const own = await cardHtml("harbor", pan.product.id, { mm: "page" }, "https://www.example.com/shop");
  is("as a page of its own, the whole sentence under the card and not the short one", [textOf(own).includes(SAID.en), textOf(own).includes(SHORT.en)], [true, false]);
  await setEmbedSites(OWNER, "");

  const digital = await cardHtml("harbor", harbor.product);
  is("a product handed over digitally goes to its buy box, where the whole sentence is, and the card says no short one", [digital.includes('action="/api/store/checkout"'), textOf(digital).includes(SHORT.en)], [false, false]);
  const unlisted = await cardHtml("harbor", pan.product.id, { mm: "overlay" }, "https://elsewhere.example.net/");
  is("a card that buys nothing here (a plain link to the product's page) says no short sentence", [unlisted.includes('action="/api/store/checkout"'), textOf(unlisted).includes(SHORT.en)], [false, false]);
  const demoPan = await addProduct(HOUSE_OWNER, "Cast iron pan", "", "59", null);
  if (!demoPan.ok) throw new Error("no demo product");
  await setProductShipping(HOUSE_OWNER, demoPan.product.id, { cents: 0, region: "us", countries: ["US"], note: "" });
  is("nor does the demo store's card", textOf(await cardHtml("demokitchen", demoPan.product.id)).includes(wordsIn("en").cardSoldBy(STORE)), false);
  process.env.STRIPE_SECRET_KEY = "sk_test_eu_who_answers_stand_in";
  is("nor a card in test mode", textOf(await cardHtml("harbor", pan.product.id)).includes(SHORT.en), false);
  process.env.STRIPE_SECRET_KEY = "sk_live_eu_who_answers_stand_in";

  part("Reviewed again once EU VAT art. 9a is built");
  is("docs/eu-vat-article-9a.md names this sentence", readFileSync("docs/eu-vat-article-9a.md", "utf8").includes("whoAnswers"), true);

  part("Nothing left the test");
  // The product pages read nothing from Stripe or anyone (the booking page does read Stripe, answered by the stand-in above).
  is("no request from the product pages reached Stripe or anyone", fromProductPages.filter((host) => host !== "example.com" && !host.endsWith(".example.com")), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
