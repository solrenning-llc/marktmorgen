/**
 * AX274, WCAG 1.3.1 Info and Relationships and 2.4.10 Section Headings (AAA): a
 * title that looks like a heading is one. Chromium on 13 November 2026, /studio:
 * the outline of headings had the cards "A sale across the store", "Visit us" and
 * "Media kit" as h2, while their sibling cards ("Contact form", "Email sign-up box",
 * "Discount codes", "Where the money goes", "The email that logs you in" and
 * twenty more) drew the same large title in a <p>. A screen reader's list of
 * headings skipped them, and moving by heading jumped over half the page.
 *
 * What must hold: each of these card titles is an h2 with the same classes, so it
 * looks exactly as before. Previews of the creator's own store inside a card
 * ("Get in touch", the store's name) are the creator's words, not studio
 * headings, and stay as they are.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const TITLE = 'className="text-lg font-semibold tracking-[-0.02em] text-ink"';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

part("Each studio card title is an h2");
for (const [file, title] of [
  ["components/tips-editor.tsx", "Support my work"],
  ["components/contact-box-editor.tsx", "Contact form"],
  ["components/join-box-editor.tsx", "Email sign-up box"],
  ["components/discount-editor.tsx", "Discount codes"],
  ["components/fair-price-editor.tsx", "Fair prices by country"],
  ["components/exit-offer-editor.tsx", "When a visitor is about to leave"],
  ["components/store-layout-editor.tsx", "Sections and news on your store"],
  ["components/collections-editor.tsx", "Collections"],
  ["components/checkout-script-editor.tsx", "Checkout on your own website"],
  ["components/answers-editor.tsx", "Answer buyers&apos; questions with AI"],
  ["components/store-assistant-editor.tsx", "{ASSISTANT_NAME}"],
  ["components/product-editor.tsx", "What you are selling"],
  ["components/link-editor.tsx", "Your links"],
  ["app/studio/page.tsx", "Your list"],
  ["app/studio/page.tsx", "Your own domain"],
  ["app/studio/page.tsx", "Email your list"],
  ["app/studio/page.tsx", "Where the money goes"],
  ["app/studio/page.tsx", "Sell with PayPal too"],
  ["app/studio/page.tsx", "Your store&rsquo;s main data, as one file"],
  ["app/studio/page.tsx", "Your plan has ended, and what your store keeps has a date"],
  ["app/studio/page.tsx", "What you have sent out this month"],
  ["app/studio/page.tsx", "What you pay us"],
  ["app/studio/page.tsx", "The email that logs you in"],
  ["app/studio/page.tsx", "Take your address"],
  ["app/studio/page.tsx", "What is not switched on here yet"],
] as const) {
  const text = readFileSync(file, "utf8");
  const asH2 = new RegExp(`<h2 ${escape(TITLE)}>\\s*${escape(title)}\\s*(</h2>|<)`);
  const asP = new RegExp(`<p ${escape(TITLE)}>\\s*${escape(title)}\\s*(</p>|<)`);
  is(`${file}: "${title}" is an h2 that looks as before, not a <p>`, [asH2.test(text), asP.test(text)], [true, false]);
}

part("Sell from your own website, in both of its states");
const buy = readFileSync("components/buy-button-editor.tsx", "utf8");
is("both titles are h2, none a <p>", [(buy.match(new RegExp(`<h2 ${escape(TITLE)}>Sell from your own website</h2>`, "g")) ?? []).length, buy.includes(`<p ${TITLE}>Sell from your own website</p>`)], [2, false]);

part("The closing card's title, today or later");
const studio = readFileSync("app/studio/page.tsx", "utf8");
is("the whole-store closing title is an h2", new RegExp(`<h2 ${escape(TITLE)}>\\s*\\{closing\\.today \\? "Your store is closing today"`).test(studio), true);

done();
