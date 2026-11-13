/**
 * A store that cannot take payments yet says so, and never sends the buyer
 * to a way of writing that is not there (#4306).
 *
 * The note under the prices used to end "To buy, write to <store> directly."
 * A new store has no contact form, no email and no link on its page, so that
 * was an instruction nobody could follow, in every buyer language. Checked on
 * synthetic records, with the pages drawn as a browser gets them:
 *
 *   - the note says only what is true, in every store language;
 *   - with the store's contact form off, neither page tells the buyer to write;
 *   - with it on (lib/store-contact.ts contactOpen), the note links to it:
 *     "#contact" on the store page, "/@<handle>#contact" from a product page,
 *     and the store page draws the form that link lands on.
 */
import { renderToReadableStream } from "react-dom/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import StorePage from "@/app/[handle]/page";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setContact, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { contactOpen } from "@/lib/store-contact";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "ana@example.com";
const STORE = "Ana Bakes";

/** No call leaves the test: every request is answered with an empty list. */
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

/** A page drawn as a browser gets it, as its markup. */
async function markup(url: string, run: () => Promise<unknown>): Promise<string> {
  answering(new Request(url));
  const node = await run();
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** The markup's text as a reader gets it. */
const textOf = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

const storePage = () =>
  markup("https://marktmorgen.com/@anabakes", () => StorePage({ params: Promise.resolve({ handle: "@anabakes" }), searchParams: Promise.resolve({}) } as Parameters<typeof StorePage>[0]));
const productPage = (product: string) =>
  markup(`https://marktmorgen.com/@anabakes/p/${product}`, () =>
    ProductPage({ params: Promise.resolve({ handle: "@anabakes", product }), searchParams: Promise.resolve({}) } as Parameters<typeof ProductPage>[0]),
  );

/** The one link whose text is `words`, as its opening tag, or "" when there is none. */
function linkTo(html: string, words: string): string {
  const at = html.indexOf(`>${words}</a>`);
  return at < 0 ? "" : html.slice(html.lastIndexOf("<a ", at), at + 1);
}

async function main(): Promise<void> {
  redis.clear();
  // A key of the live shape so the page is not in Stripe's test mode; no Stripe account is connected.
  process.env.STRIPE_SECRET_KEY = "sk_live_no_payments_contact_stand_in";
  // An existing synthetic credential (tests/resend-fixture-credentials.ts): the form needs a sender; nothing is sent.
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("The note, in every store language");
  for (const code of LANGUAGE_CODES) {
    const w = wordsIn(code) as unknown as Record<string, unknown>;
    is(`${code}: the note names no one to write to`, [typeof w.noPaymentsBody, typeof w.noPaymentsBodyOne], ["string", "string"]);
    const write = w.noPaymentsWrite;
    is(`${code}: the link to the form names the store`, typeof write === "function" && (write as (s: string) => string)(STORE).includes(STORE), true);
  }

  const made = await claimHandle(OWNER, "anabakes", STORE, "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_anabakes01", subscriptionId: "sub_anabakes01", active: true, tier: "creator", period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough Starter Guide", "", "19", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");

  part("No contact form: nothing tells the buyer to write");
  const shutStore = await storePage();
  const shutProduct = await productPage(added.product.id);
  is("the store page says the prices are real and nothing can charge a card", textOf(shutStore).includes("The prices above are real, but nothing here can charge a card."), true);
  is("the product page says the same of its price", textOf(shutProduct).includes("The price above is real, but nothing here can charge a card."), true);
  is("neither page asks the buyer to write", [/write to/i.test(textOf(shutStore)), /write to/i.test(textOf(shutProduct))], [false, false]);
  is("and there is no form to send them to", shutStore.includes('id="contact"'), false);

  part("With the contact form on, the note links to it");
  await setContact(OWNER, { on: true, heading: "", line: "" });
  is("the form is open for this store", contactOpen((await storeForEmail(OWNER))!), true);
  const openStore = await storePage();
  const openProduct = await productPage(added.product.id);
  is("the store page links to its own form", linkTo(openStore, `Write to ${STORE}`).includes('href="#contact"'), true);
  is("the form the link lands on is drawn", openStore.includes('id="contact"'), true);
  is("the product page links to the store page's form", linkTo(openProduct, `Write to ${STORE}`).includes('href="/@anabakes#contact"'), true);

  done();
}

void main();
