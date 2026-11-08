/**
 * CX-123 rule 24 on the buyer pages outside a store's own address (sweep of
 * app/embed/** and app/library/**, 6 November 2026): a read that failed or
 * came back out of shape is unknown, never "not there".
 *
 *   - The product card on the creator's own site said "This product is no
 *     longer on sale." when the store or the product could not be read, and
 *     drew a buy button for a coming-soon product whose state could not be
 *     read (app/embed/[handle]/[product]/page.tsx).
 *   - The sign-up form on the creator's own site said "This list is not
 *     taking sign-ups" when the store could not be read
 *     (app/embed/[handle]/join/page.tsx).
 *   - The buyer's library said "Nothing is listed for this address any
 *     more." when its list of stores came back out of shape
 *     (lib/buyer-library.ts storesBoughtFrom), and left out, without a word,
 *     a store whose record could not be read (app/library/page.tsx).
 *   - Since Claude 5's review of #2910: the coming-soon state out of shape
 *     (no reply, a word, a 2) as well as failed; a library link whose
 *     address did not read said it had expired (libraryOwner); and asking
 *     for a link said "on its way" with nothing sent when no store read
 *     (requestLibraryLink).
 *   - Since Codex J's focal return on #2910: a store whose address or id
 *     answered out of shape (no reply, a number), or whose record behind it
 *     did not read, was taken for a store that is not there by the tolerant
 *     readers of lib/store.ts. The card, the sign-up form, the library and
 *     the link request now read that key exactly first (lib/store-exact.ts).
 *   - Since Claude 3's second review of #2910: the product's own record out
 *     of shape (no reply, a number) still said "no longer on sale"; the
 *     card's "not on sale" box did not carry the store's language (3.1.2);
 *     and the store's address key was read twice per view. Since Claude 4's
 *     finding: a key pool whose count could not be read showed "Buy".
 *
 * Each unknown case is checked against a control where the same thing is
 * truly absent, which keeps its old answer. Synthetic store; one reply
 * injected per case; no network.
 */
import { createHash } from "node:crypto";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import EmbedJoin from "@/app/embed/[handle]/join/page";
import LibraryPage from "@/app/library/page";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { readListing } from "@/lib/catalog";
import { requestLibraryLink, storesBoughtFrom } from "@/lib/buyer-library";
import { personWrite } from "@/lib/joined-stores";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let inject: { when: (c: Command) => boolean; reply: () => unknown[] | Promise<unknown[]> } | null = null;
/** Every command sent while set, to count what one view reads. */
let log: Command[] | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (log) log.push(...batch);
  if (inject && batch.some(inject.when)) return inject.reply();
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** The rendered text, with tags and entities read, so a sentence is found whatever markup holds it. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const failed = () => Promise.reject(new Error("synthetic Redis failure"));
const getOf = (prefix: string) => (c: Command) => c[0] === "GET" && typeof c[1] === "string" && c[1].startsWith(prefix);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_embed_library_stand_in";
  redis.clear();
  const owner = "embed-library-unknown@example.test";
  await claimHandle(owner, "emblibunknown", "Embed Library Unknown", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_EmbLib00001", subscriptionId: "sub_EmbLib00001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1EmbLibUnknown1", true);
  // More products than the store's first page, so the last one is read from its own record, not from the store's.
  const ids: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    const made = await addProduct(owner, `Guide ${i + 1}`, "A synthetic guide.", "40", null);
    if (!made.ok) throw new Error("product fixture");
    await setProductLink(owner, made.product.id, `https://example.test/guide-${i + 1}`);
    ids.push(made.product.id);
  }
  const store = (await storeForEmail(owner))!;
  const inHead = new Set(store.catalog.head.map((l) => l.id));
  const fromHead = ids.find((id) => inHead.has(id))!;
  const ownRecord = ids.find((id) => !inHead.has(id));
  if (!fromHead || !ownRecord || store.catalog.inline) throw new Error("catalog fixture: a product in the head and one read from its own record");
  const listing = (await readListing(store, fromHead))!;
  const w = wordsIn(store.language);
  const card = async (handle: string, product: string) => {
    answering(new NextRequest(`https://marktmorgen.com/embed/${handle}/${product}`));
    return text(await html((await EmbedCard({ params: Promise.resolve({ handle, product }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement));
  };

  part("The card: controls");
  const healthy = await card("emblibunknown", fromHead);
  is("a product on sale shows its buy button", healthy.includes(w.buyFor("$40")), true);
  is("a store that does not exist says the product is no longer on sale", (await card("nobodyhere", fromHead)).includes("This product is no longer on sale."), true);
  is("a product the store does not have says it is no longer on sale, in the store's words", (await card("emblibunknown", "p_missing_product")).includes(w.noLongerOnSale), true);

  part("The card: a store that could not be read");
  inject = { when: getOf("nl:store:handle:"), reply: failed };
  const storeUnread = await card("emblibunknown", fromHead);
  inject = null;
  is("never says the product is no longer on sale", storeUnread.includes("no longer on sale"), false);
  is("says it could not be loaded just now", storeUnread.includes("could not be loaded just now"), true);

  part("The card: a store whose address or record answered out of shape");
  const handleRead = getOf("nl:store:handle:");
  inject = { when: handleRead, reply: () => [null] };
  is("control: an address confirmed free says the product is no longer on sale", (await card("emblibunknown", fromHead)).includes("This product is no longer on sale."), true);
  inject = null;
  for (const [name, when, reply] of [
    ["no reply for its address", handleRead, () => []],
    ["a number for its address", handleRead, () => [7]],
    ["a list for its address", handleRead, () => [["x"]]],
    ["no reply for its record", getOf("nl:store:owner:"), () => []],
  ] as const) {
    inject = { when, reply };
    const shown = await card("emblibunknown", fromHead);
    inject = null;
    is(`${name}: never says the product is no longer on sale`, shown.includes("no longer on sale"), false);
    is(`${name}: says it could not be loaded just now`, shown.includes("could not be loaded just now"), true);
  }

  part("The card: a product that could not be read");
  inject = { when: getOf(`nl:catalog:${store.catalog.id}:l:${ownRecord}`), reply: failed };
  const productUnread = await card("emblibunknown", ownRecord);
  inject = null;
  is("never says the product is no longer on sale", productUnread.includes(w.noLongerOnSale), false);
  is("says it could not be loaded just now", productUnread.includes("could not be loaded just now"), true);
  is("and still leads to the store", productUnread.includes(w.seeStore(store.name)), true);

  part("The card: a product whose own record answered out of shape (Claude 3, second review of #2910)");
  const productRead = getOf(`nl:catalog:${store.catalog.id}:l:${ownRecord}`);
  inject = { when: productRead, reply: () => [null] };
  is("control: a product record confirmed absent says the product is no longer on sale", (await card("emblibunknown", ownRecord)).includes(w.noLongerOnSale), true);
  inject = null;
  is("control: the product's own record, read as asked, shows its buy button", (await card("emblibunknown", ownRecord)).includes(w.buyFor("$40")), true);
  for (const [name, reply] of [
    ["no reply for the product's record", () => []],
    ["a number for the product's record", () => [7]],
    ["a list for the product's record", () => [["x"]]],
    ["a record that is not JSON", () => ["{"]],
    ["a record of another product", () => [JSON.stringify({ ...listing, id: fromHead })]],
  ] as const) {
    inject = { when: productRead, reply };
    const shown = await card("emblibunknown", ownRecord);
    inject = null;
    is(`${name}: never says the product is no longer on sale`, shown.includes(w.noLongerOnSale), false);
    is(`${name}: says it could not be loaded just now`, shown.includes("could not be loaded just now"), true);
    is(`${name}: no buy button`, shown.includes(w.buyFor("$40")), false);
  }

  part("The card: whether it is coming soon could not be read");
  const soonRead = (c: Command) => c[0] === "SISMEMBER" && c[1] === `nl:wl:${store.statsId}:soon`;
  inject = { when: soonRead, reply: () => [1, null] };
  is("control: a coming-soon product leads to its waitlist", (await card("emblibunknown", fromHead)).includes(w.joinWaitlist), true);
  inject = { when: soonRead, reply: () => [0, null] };
  is("control: a product confirmed not coming soon shows its buy button", (await card("emblibunknown", fromHead)).includes(w.buyFor("$40")), true);
  // soonOne reads the SISMEMBER exactly (lib/preorders.ts, #2846): a failed request and an answer out of shape are
  // both unknown, never "not coming soon".
  for (const [name, reply] of [
    ["a failed request", failed],
    ["no membership answer", () => [null, null]],
    ["no reply at all", () => []],
    ["a word for the membership", () => ["QUEUED", null]],
    ["a membership of 2", () => [2, null]],
  ] as const) {
    inject = { when: soonRead, reply };
    const soonUnread = await card("emblibunknown", fromHead);
    inject = null;
    is(`${name}: no buy button for something that may not be out yet`, soonUnread.includes(w.buyFor("$40")), false);
    is(`${name}: says buying is not available just now`, soonUnread.includes("Buying is not available just now"), true);
    is(`${name}: the product's title is still shown and leads to its page`, soonUnread.includes(listing.title), true);
  }

  part("The card's words, in every language the store can have");
  const codes = Object.keys(LANGUAGES) as LanguageCode[];
  for (const key of ["cardUnread", "cardBuyUnread"]) {
    is(`${key} exists in every language`, codes.filter((code) => typeof (wordsIn(code) as unknown as Record<string, unknown>)[key] !== "string"), []);
  }

  const join = async (handle: string) => {
    answering(new NextRequest(`https://marktmorgen.com/embed/${handle}/join`));
    return text(await html((await EmbedJoin({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement));
  };
  part("The sign-up form: a store that could not be read");
  is("control: a store that does not exist says the list is not taking sign-ups", (await join("nobodyhere")).includes("This list is not taking sign-ups"), true);
  inject = { when: getOf("nl:store:handle:"), reply: failed };
  const joinUnread = await join("emblibunknown");
  inject = null;
  is("never says the list is not taking sign-ups", joinUnread.includes("not taking sign-ups"), false);
  is("says it could not be loaded just now", joinUnread.includes("could not be loaded just now"), true);
  for (const [name, when, reply] of [
    ["no reply for its address", getOf("nl:store:handle:"), () => []],
    ["a number for its address", getOf("nl:store:handle:"), () => [7]],
    ["no reply for its record", getOf("nl:store:owner:"), () => []],
  ] as const) {
    inject = { when, reply };
    const shown = await join("emblibunknown");
    inject = null;
    is(`${name}: never says the list is not taking sign-ups`, shown.includes("not taking sign-ups"), false);
    is(`${name}: says it could not be loaded just now`, shown.includes("could not be loaded just now"), true);
  }

  part("The library");
  const buyer = "embed-library-buyer@example.test";
  await real(personWrite("nl:lib:", "nimbus-lib", buyer, store.sid));
  const token = "ab".repeat(32);
  await real([["SET", `nl:lib:link:${createHash("sha256").update(`nimbus-lib-link:${token}`).digest("hex").slice(0, 40)}`, buyer, "EX", 86_400]]);
  const library = async () => text(await html((await LibraryPage({ searchParams: Promise.resolve({ token }) } as never)) as React.ReactElement));
  is("control: the store bought from is listed", (await library()).includes(store.name), true);
  is("control: its stores are read exactly", await storesBoughtFrom(buyer), [store.sid]);

  const sunion = (c: Command) => c[0] === "SUNION";
  for (const [name, reply] of [
    ["the stores answered as a string", () => ["x"]],
    ["the stores answered with a number among them", () => [[store.sid, 7]]],
    ["no reply at all", () => []],
  ] as const) {
    inject = { when: sunion, reply };
    is(`${name}: storesBoughtFrom says the reading is unknown`, await storesBoughtFrom(buyer).then(() => "known", () => "unknown"), "unknown");
    const shown = await library();
    inject = null;
    is(`${name}: never says nothing is listed`, shown.includes("Nothing is listed for this address"), false);
    is(`${name}: says the stores could not be read just now`, shown.includes("could not be read just now"), true);
  }

  part("The library: a link whose address could not be read");
  const expired = "That link has expired or was already replaced.";
  is("control: a link that does not exist has expired", text(await html((await LibraryPage({ searchParams: Promise.resolve({ token: "cd".repeat(32) }) } as never)) as React.ReactElement)).includes(expired), true);
  for (const [name, reply] of [
    ["no reply at all", () => []],
    ["a number for the address", () => [7]],
    ["a list for the address", () => [["x"]]],
    ["a failed request", failed],
  ] as const) {
    inject = { when: getOf("nl:lib:link:"), reply };
    const shown = await library().catch(() => "the page threw");
    inject = null;
    is(`${name}: never says the link has expired`, shown.includes("expired"), false);
    is(`${name}: says the link could not be read just now`, shown.includes("That link could not be read just now"), true);
  }

  part("The library: asking for a link when no store could be read");
  // A link is made (its SET) only on the way to emailing it; the email itself is not sent here (no sender in tests).
  const made: Command[] = [];
  const watched = redis.pipeline;
  redis.pipeline = (async (batch: Command[]) => {
    made.push(...batch.filter((c) => c[0] === "SET" && typeof c[1] === "string" && c[1].startsWith("nl:lib:link:")));
    return watched(batch);
  }) as typeof redis.pipeline;
  process.env.RESEND_API_KEY = "re_test_embed_library_stand_in";
  const ask = (email: string, ip: string) => requestLibraryLink({ email, ip, origin: "https://marktmorgen.com" });
  await ask(buyer, "203.0.113.21");
  is("control: a store that reads: a link is made for its buyer", made.length, 1);
  is("control: an address that bought nothing: the same answer, and no link", [await ask("nobody-here@example.test", "203.0.113.22"), made.length], ["sent", 1]);
  inject = { when: getOf("nl:store:id:"), reply: failed };
  const unreadAsk = await ask(buyer, "203.0.113.23");
  inject = null;
  is("a store whose record could not be read: never says a link is on its way", unreadAsk, "error");
  is("a store whose record could not be read: and makes no link", made.length, 1);
  for (const [name, when, reply, ip] of [
    ["no reply for its id", getOf("nl:store:id:"), () => [], "203.0.113.24"],
    ["a number for its id", getOf("nl:store:id:"), () => [7], "203.0.113.25"],
    ["no reply for its record", getOf("nl:store:owner:"), () => [], "203.0.113.26"],
  ] as const) {
    inject = { when, reply };
    const result = await ask(buyer, ip);
    inject = null;
    is(`a store with ${name}: never says a link is on its way`, result, "error");
    is(`a store with ${name}: and makes no link`, made.length, 1);
  }
  // Another buyer of the same store, so the address's own hourly limit is not what answers.
  const second = "embed-library-second@example.test";
  await real(personWrite("nl:lib:", "nimbus-lib", second, store.sid));
  inject = { when: getOf("nl:store:id:"), reply: () => [null] };
  const goneAsk = await ask(second, "203.0.113.27");
  inject = null;
  is("control: a store confirmed gone: the same answer as for an address that bought nothing, and no link", [goneAsk, made.length], ["sent", 1]);
  delete process.env.RESEND_API_KEY;
  redis.pipeline = watched;

  inject = { when: getOf("nl:store:id:"), reply: failed };
  const storeGone = await library();
  inject = null;
  is("a store whose record could not be read: never says nothing is listed", storeGone.includes("Nothing is listed for this address"), false);
  is("a store whose record could not be read: says one store could not be read just now", storeGone.includes("1 store could not be read just now"), true);

  part("The library: a store whose id or record answered out of shape");
  inject = { when: getOf("nl:store:id:"), reply: () => [null] };
  const confirmedGone = await library();
  inject = null;
  is("control: a store confirmed gone is left out, and nothing is listed", confirmedGone.includes("Nothing is listed for this address"), true);
  is("control: a store confirmed gone is not said to be unread", confirmedGone.includes("could not be read just now"), false);
  for (const [name, when, reply] of [
    ["no reply for its id", getOf("nl:store:id:"), () => []],
    ["a number for its id", getOf("nl:store:id:"), () => [7]],
    ["no reply for its record", getOf("nl:store:owner:"), () => []],
  ] as const) {
    inject = { when, reply };
    const shown = await library();
    inject = null;
    is(`${name}: never says nothing is listed`, shown.includes("Nothing is listed for this address"), false);
    is(`${name}: says one store could not be read just now`, shown.includes("1 store could not be read just now"), true);
  }

  part("What one view reads (Claude 3, second review of #2910): the store's key once");
  const handleKeyOf = getOf("nl:store:handle:emblibunknown");
  log = [];
  await card("emblibunknown", fromHead);
  const cardRead = log;
  log = [];
  answering(new NextRequest("https://marktmorgen.com/embed/emblibunknown/join"));
  await html((await EmbedJoin({ params: Promise.resolve({ handle: "emblibunknown" }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  const joinRead = log;
  log = [];
  await library();
  const libraryRead = log;
  log = null;
  is("a card view reads the store's address key once", cardRead.filter(handleKeyOf).length, 1);
  is("a card view sends at most 5 commands", cardRead.length <= 5 ? "at most 5" : `${cardRead.length}: ${cardRead.map((c) => c[0]).join(", ")}`, "at most 5");
  is("a sign-up form view reads the store's address key once", joinRead.filter(handleKeyOf).length, 1);
  is("a sign-up form view sends at most 7 commands", joinRead.length <= 7 ? "at most 7" : `${joinRead.length}: ${joinRead.map((c) => c[0]).join(", ")}`, "at most 7");
  is("a library view reads each store's id key once", libraryRead.filter(getOf(`nl:store:id:${store.sid}`)).length, 1);

  part("The card's \"not on sale\" box speaks the store's language (Claude 3, second review of #2910; 3.1.2)");
  await setLanguage(owner, "de");
  const de = wordsIn("de");
  const rawCard = async (product: string) => {
    answering(new NextRequest(`https://marktmorgen.com/embed/emblibunknown/${product}`));
    return html((await EmbedCard({ params: Promise.resolve({ handle: "emblibunknown", product }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  };
  /** The lang of the element that holds this sentence: the innermost element with a lang that opens before it and holds it. */
  const langAround = (markup: string, sentence: string): string | null => {
    const at = text(markup).indexOf(sentence) >= 0 ? markup.indexOf(sentence.slice(0, 12)) : -1;
    if (at < 0) return null;
    const opened = [...markup.slice(0, at).matchAll(/<([a-z]+)[^>]*\blang="([^"]+)"[^>]*>/g)];
    for (let i = opened.length - 1; i >= 0; i -= 1) {
      const tag = opened[i][1];
      const between = markup.slice(opened[i].index! + opened[i][0].length, at);
      const opens = (between.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
      const closes = (between.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      if (closes <= opens) return opened[i][2];
    }
    return null;
  };
  is("control: a German card itself carries the store's lang", langAround(await rawCard(fromHead), listing.title.slice(0, 12))?.startsWith("de") ?? false, true);
  inject = { when: productRead, reply: failed };
  const unreadDe = await rawCard(ownRecord);
  inject = null;
  is("control: the German 'could not be loaded' sentence is drawn", text(unreadDe).includes(de.cardUnread), true);
  is("the German 'could not be loaded' sentence sits inside an element whose lang is German", langAround(unreadDe, de.cardUnread)?.startsWith("de") ?? false, true);
  const goneDe = await rawCard("p_missing_product");
  is("control: the German 'no longer on sale' sentence is drawn", text(goneDe).includes(de.noLongerOnSale), true);
  is("the German 'no longer on sale' sentence sits inside an element whose lang is German", langAround(goneDe, de.noLongerOnSale)?.startsWith("de") ?? false, true);
  await setLanguage(owner, "en");

  part("The card: a key pool whose count could not be read (Claude 4 on #2910)");
  const app = await addProduct(owner, "Desktop app", "A synthetic app.", "40", null);
  if (!app.ok) throw new Error("key product fixture");
  await setProductLink(owner, app.product.id, "https://example.test/app");
  is("the product hands out keys from a pool", (await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" })).ok, true);
  const poolKey = `nl:keys:${store.statsId}:${app.product.id}:pool`;
  const poolRead = (c: Command) => c[0] === "LLEN" && c[1] === poolKey;
  await real([["RPUSH", poolKey, "KEY-ONE"]]);
  is("control: a key left shows the buy button", (await card("emblibunknown", app.product.id)).includes(w.buyFor("$40")), true);
  inject = { when: poolRead, reply: () => [0] };
  const emptyPool = await card("emblibunknown", app.product.id);
  inject = null;
  is("control: an empty pool shows no buy button", emptyPool.includes(w.buyFor("$40")), false);
  for (const [name, reply] of [
    ["a failed request", failed],
    ["no reply at all", () => []],
    ["a word for the count", () => ["QUEUED"]],
    ["a negative count", () => [-1]],
  ] as const) {
    inject = { when: poolRead, reply };
    const shown = await card("emblibunknown", app.product.id);
    inject = null;
    is(`${name}: no buy button for something that may be sold out`, shown.includes(w.buyFor("$40")), false);
    is(`${name}: says buying is not available just now`, shown.includes("Buying is not available just now"), true);
    is(`${name}: the product's title is still shown`, shown.includes("Desktop app"), true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
