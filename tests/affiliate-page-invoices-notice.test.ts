/**
 * The affiliate's own page in a store (app/[handle]/affiliates) says so when
 * the membership and payment plan payments behind its figures were not all
 * read (VR 2; the book's invoicesChecked, lib/affiliates.ts readBook, and
 * unsettledBook in lib/paypal-payouts.ts, which keeps the creator from paying
 * on such a book).
 *
 * The defect this file was written around: the creator's studio warned that
 * recurring commissions might be short when the invoices were not read whole,
 * but the affiliate's page showed what they earned and what they are owed
 * with no word about it, a figure possibly below what is owed shown as if it
 * were complete. Only the refunds had a notice. Checked:
 *
 *   - which notices a book gets (bookUnchecked, lib/affiliate-book-snapshot.ts):
 *     none for a whole book; "invoices" whenever invoicesChecked is not true,
 *     past the book's ceiling or not, and for a kept part written before the
 *     field existed (unknown fails closed); "refunds" as before;
 *   - the part of the book kept for the page carries it through JSON, as the
 *     page reads it (bookSlice, keptSlice);
 *   - the sentence exists in every buyer language, has no figure in it, is
 *     short, and is not the English one in another language;
 *   - the page shows each notice from that function, as role="status", in
 *     words and not by colour alone, and reads nothing new for it.
 */
import { readFileSync } from "node:fs";
import * as snapshot from "@/lib/affiliate-book-snapshot";
import { bookSlice, keptSlice } from "@/lib/affiliate-book-snapshot";
import type { Book } from "@/lib/affiliates";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

const ENGLISH = "Some payments on memberships and payment plans could not be checked, so commissions on them may be missing from these figures.";

const book = (over: Partial<Book> = {}): Book => ({
  rows: [],
  lines: [],
  payouts: [],
  currency: "usd",
  elsewhere: 0,
  refundsChecked: true,
  invoicesChecked: true,
  unlinkedInvoices: 0,
  ...over,
});

async function main(): Promise<void> {
  const unchecked = (snapshot as Record<string, unknown>).bookUnchecked as ((b: Pick<Book, "refundsChecked" | "invoicesChecked">) => string[]) | undefined;

  part("Which notices a book gets");
  is("the page has one function that says which", typeof unchecked, "function");
  const say = (b: Pick<Book, "refundsChecked" | "invoicesChecked">) => (unchecked ? unchecked(b) : ["missing"]);
  is("a whole book: none", say(book()), []);
  is("invoices not read whole: the invoices notice", say(book({ invoicesChecked: false })), ["invoices"]);
  is("invoices past what the book can keep: the same notice", say(book({ invoicesChecked: false, invoicesPastCeiling: true })), ["invoices"]);
  is("refunds not all checked: the refunds notice, as before", say(book({ refundsChecked: false })), ["refunds"]);
  is("both: both, refunds first", say(book({ refundsChecked: false, invoicesChecked: false })), ["refunds", "invoices"]);
  const older = JSON.parse(JSON.stringify(book())) as Record<string, unknown>;
  delete older.invoicesChecked;
  is("a kept part from before the field existed is not taken as whole", say(older as unknown as Book), ["invoices"]);
  is("nor one whose field is not exactly true", say({ refundsChecked: true, invoicesChecked: "true" as unknown as boolean }), ["invoices"]);

  part("The part kept for the page carries it");
  const kept = JSON.parse(JSON.stringify(keptSlice(bookSlice(book({ invoicesChecked: false, invoicesPastCeiling: true }), "aaaaaaaaaaaa")))) as Book;
  is("an affiliate's kept part, read back as the page reads it, still says the invoices were not read whole", [kept.invoicesChecked, say(kept)], [false, ["invoices"]]);
  const whole = JSON.parse(JSON.stringify(keptSlice(bookSlice(book(), "aaaaaaaaaaaa")))) as Book;
  is("and a whole one gets no notice", say(whole), []);

  part("The sentence in every buyer language");
  const words = (code: (typeof LANGUAGE_CODES)[number]) => (AFFILIATES_WORDS[code] as unknown as Record<string, unknown>).invoicesUnchecked;
  is("English, plain and with no figure", words("en"), ENGLISH);
  for (const code of LANGUAGE_CODES) {
    const text = words(code);
    is(`${code}: a sentence of its own, with no figure in it, short`, [
      typeof text === "string" && text.trim().length > 0,
      typeof text === "string" && !/\d/.test(text),
      typeof text === "string" && text.length <= 200,
      code === "en" || text !== ENGLISH,
    ], [true, true, true, true]);
  }

  part("The page shows it");
  const page = readFileSync("app/[handle]/affiliates/page.tsx", "utf8");
  const at = page.indexOf("bookUnchecked(book)");
  const block = at > 0 ? page.slice(at, at + 500) : "";
  is("the notices come from that function, inside the figures", [at > 0, at > page.indexOf("{row && book ? ("), at < page.indexOf("<AffiliatePromotionResults")], [true, true, true]);
  is("each as role=\"status\", in the store's words for refunds and for invoices", [block.includes('role="status"'), block.includes("a.refundsUnchecked"), block.includes("a.invoicesUnchecked")], [true, true, true]);
  is("the old refunds-only test is gone, so there is one way the page decides", page.includes("!book.refundsChecked ?"), false);
  is("nothing new is read for it: the page never works the book out itself", page.includes("await readBook("), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
