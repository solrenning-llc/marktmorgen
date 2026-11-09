/**
 * The service emails a store sends its buyers speak the store's language
 * (lib/store-language.ts) and say which language that is (AX274, WCAG 3.1.1):
 *
 *   - the one "your purchases moved" email to past buyers an import brings
 *     over (lib/imports.ts movedEmail), in all seven languages, every name,
 *     address and link in it, and English word for word as before;
 *   - the API's "you were given a product" email (lib/api-write.ts) marks its
 *     HTML with the store's language;
 *   - every plain letter built in lib/imports.ts and lib/api-write.ts does too.
 *
 * Synthetic store and buyers; no provider is reached: fetch is a stand-in that
 * records what would have been sent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { movedEmail, type ImportJob } from "@/lib/imports";
import { grantImported } from "@/lib/imported-purchases";
import { makeKey } from "@/lib/api-keys";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setLanguage, setPastBuyers, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { LANGUAGES, LANGUAGE_CODES } from "@/lib/store-language";
import { MOVED_PURCHASE_WORDS } from "@/lib/buyer-words/moved-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string | string[]; subject: string; text: string; html?: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body));
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one as Sent);
    return new Response(JSON.stringify({ id: `email_lang_${emails.length}`, data: [] }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${url}` } }), { status: 404 });
}) as typeof fetch;

const OWNER = "owner@example.com";
const BUYER = "buyer@example.com";
const ONE_JOB = "0123456789abcdef01234567";
const TWO_JOB = "89abcdef0123456789abcdef";

/** The English email as it has always read, for one product and for two. */
function englishOne(store: string, title: string, base: string, email: string) {
  return {
    subject: `${title} has moved to ${store}`,
    text: [
      `${store} has moved to a new store, and what you bought before comes with you. Nothing was charged, and you do not need to buy it again.`,
      "",
      "Yours there:",
      `- ${title}`,
      "",
      `To open it, go to ${base}/orders and type ${email}. A link to everything you have there arrives within a minute. There is no password to make.`,
      "",
      `You are getting this one email because ${store} moved your purchases. Nothing more is sent because of it.`,
      `Sent by Marktmorgen on behalf of ${store}.`,
    ].join("\n"),
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  await claimHandle(OWNER, "lindenhof", "Lindenhof Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_EmailLang00001", subscriptionId: "sub_EmailLang00001", active: true, period: paidPeriod() });
  const first = await addProduct(OWNER, "Sourdough Basics", "", "12", null);
  const second = await addProduct(OWNER, "Rye Workbook", "", "9", null);
  if (!first.ok || !second.ok) throw new Error("no product");
  await setProductLink(OWNER, first.product.id, "https://example.com/sourdough");
  await setProductLink(OWNER, second.product.id, "https://example.com/rye");
  await setPastBuyers(OWNER);
  let store = (await storeForEmail(OWNER))!;
  await grantImported(store.statsId!, ONE_JOB, [{ email: BUYER, productId: first.product.id, items: null }], undefined, store.sid!, store);
  await grantImported(
    store.statsId!,
    TWO_JOB,
    [
      { email: "two@example.com", productId: first.product.id, items: null },
      { email: "two@example.com", productId: second.product.id, items: null },
    ],
    undefined,
    store.sid!,
    store,
  );
  const base = `https://marktmorgen.com/@${store.handle}`;

  part("The API's 'you were given a product' email says its language");
  await setLanguage(OWNER, "de");
  store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid!, "Zapier", Date.now(), true);
  if (!writer.ok) throw new Error("no key");
  const before = emails.length;
  const response = await postAccess(
    new Request("https://marktmorgen.com/api/v1/access", {
      method: "POST",
      headers: { Authorization: `Bearer ${writer.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "neu@example.de", product: second.product.id, notify: true }),
    }),
  );
  const sent = emails[before];
  is("control: the email went, in German", [response.status, Boolean(sent), sent?.text.split("\n")[0].includes("hat Ihnen")], [200, true, true]);
  is("its HTML is marked German (lang=\"de-DE\")", Boolean(sent?.html && /^<div lang="de-DE"/.test(sent.html)), true);
  is("and its text and HTML say the same first paragraph", Boolean(sent?.html?.includes(sent.text.split("\n")[0].replace(/&/g, "&amp;"))), true);

  await setLanguage(OWNER, "en");
  store = (await storeForEmail(OWNER))!;

  part("English: the moved email reads word for word as before");
  const enOne = await movedEmail(store, { id: ONE_JOB } as ImportJob, BUYER);
  is("one product: subject and text unchanged", enOne, englishOne(store.name, "Sourdough Basics", base, BUYER));
  const enTwo = await movedEmail(store, { id: TWO_JOB } as ImportJob, "two@example.com");
  is("two products: the subject and the way to open any of them unchanged", [enTwo?.subject, enTwo?.text.includes(`To open any of it, go to ${base}/orders and type two@example.com.`)], ["What you bought from Lindenhof Studio has moved", true]);
  is("and both products are listed", [enTwo?.text.includes("- Sourdough Basics"), enTwo?.text.includes("- Rye Workbook")], [true, true]);

  for (const code of LANGUAGE_CODES.filter((c) => c !== "en")) {
    await setLanguage(OWNER, code);
    store = (await storeForEmail(OWNER))!;
    const name = LANGUAGES[code].english;
    part(`${name}: the moved email to past buyers`);
    const one = await movedEmail(store, { id: ONE_JOB } as ImportJob, BUYER);
    const two = await movedEmail(store, { id: TWO_JOB } as ImportJob, "two@example.com");
    if (!one || !two || !enOne || !enTwo) {
      is("an email is written", [Boolean(one), Boolean(two)], [true, true]);
      continue;
    }
    const oneLines = one.text.split("\n");
    const enLines = enOne.text.split("\n");
    is("as many lines as English", [oneLines.length, two.text.split("\n").length], [enLines.length, enTwo.text.split("\n").length]);
    is("its subject is not the English one", [one.subject === enOne.subject, two.subject === enTwo.subject], [false, false]);
    const sameAsEnglish = oneLines.filter((line, i) => line.length > 3 && line === enLines[i] && line !== "- Sourdough Basics");
    is("no sentence left in English", sameAsEnglish, []);
    is("the product and the store are named in the subject", [one.subject.includes("Sourdough Basics"), one.subject.includes(store.name), two.subject.includes(store.name)], [true, true, true]);
    is("the buyer's address and the orders page are in it", [one.text.includes(BUYER), one.text.includes(`${base}/orders`), two.text.includes("two@example.com"), two.text.includes(`${base}/orders`)], [true, true, true, true]);
    is("every product is listed", [one.text.includes("- Sourdough Basics"), two.text.includes("- Sourdough Basics"), two.text.includes("- Rye Workbook")], [true, true, true]);
    is("one product and two are not said the same way", oneLines[5] === two.text.split("\n")[6], false);
    is("the store is named where English names it (why and sent by)", [oneLines.at(-2)?.includes(store.name), oneLines.at(-1)?.includes(store.name), oneLines.at(-1)?.includes("Marktmorgen")], [true, true, true]);
    is("nothing left as a placeholder", /\$\{|undefined|NaN|\[object/.test(`${one.subject}${one.text}${two.subject}${two.text}`), false);
    if (code === "fr") {
      const prose = `${one.text}\n${two.text}`.replace(/https?:\/\/\S+/g, "").replace(/\S+@\S+/g, "");
      is("French spaces its : ? ! ; from the word before", /[^ \s][:?!;](\s|$)/.test(prose), false);
    }
  }

  part("The moved email's words: the same keys in every language, a course's line too");
  const keys = Object.keys(MOVED_PURCHASE_WORDS.en);
  for (const code of LANGUAGE_CODES) {
    const words = MOVED_PURCHASE_WORDS[code];
    const line = words.courseLine("\u00abtitle\u00bb", "https://marktmorgen.com/@x/course/1");
    is(`${LANGUAGES[code].english}: every key English has, and a course line naming the course and its link`, [Object.keys(words), line.includes("\u00abtitle\u00bb"), line.includes("https://marktmorgen.com/@x/course/1")], [keys, true, true]);
  }
  is("French spaces the course line's colon", MOVED_PURCHASE_WORDS.fr.courseLine("T", "u"), "- T\u00a0: u");

  part("Every plain letter built in these files carries its language");
  for (const file of ["lib/imports.ts", "lib/api-write.ts"]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const unmarked = (source.match(/<div style="font-family:system-ui[^`]*/g) ?? []).length;
    is(`${file}: no letter <div> without lang`, unmarked, 0);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
