/**
 * A store's buyer-facing pages and transactional mail use its language. The
 * mandatory service emails sent when that store closes must do the same,
 * without changing their date, contact, refund or access policy.
 */
import { readFileSync } from "node:fs";
import {
  BUYER_NOTICE_DAYS,
  CLOSING_ACCESS_SENTENCE,
  type BuyerLetter,
  buyerNotice,
  letterHtml,
  refundShortLetter,
  refundUnmadeLetter,
  staysOpenLetter,
} from "@/lib/closing-buyers-rules";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

type NoticeInput = {
  store: string;
  storeUrl: string;
  day: number;
  contact: string;
  refund?: string;
  member?: boolean;
  paused?: boolean;
  language: LanguageCode;
};

type StoreInput = { store: string; storeUrl: string; contact: string; language: LanguageCode };
type RefundInput = { store: string; amount: string; contact: string; language: LanguageCode };

const noticeFor = buyerNotice as unknown as (input: NoticeInput) => BuyerLetter;
const staysFor = staysOpenLetter as unknown as (input: StoreInput) => BuyerLetter;
const shortFor = refundShortLetter as unknown as (input: RefundInput) => BuyerLetter;
const unmadeFor = refundUnmadeLetter as unknown as (input: RefundInput) => BuyerLetter;
const htmlFor = letterHtml as unknown as (text: string, postal: string, language: LanguageCode) => string;

const STORE = "Harbor Kitchen";
const STORE_URL = "https://marktmorgen.example/@harbor";
const CONTACT = "owner@harbor.example";
const AMOUNT = "$18.45";
const POSTAL = "100 Example Street, Example City, United States";
const DAY = Date.UTC(2026, 11, 18);

const letters = (language: LanguageCode) => ({
  notice: noticeFor({ store: STORE, storeUrl: STORE_URL, day: DAY, contact: CONTACT, refund: AMOUNT, member: true, paused: true, language }),
  stays: staysFor({ store: STORE, storeUrl: STORE_URL, contact: CONTACT, language }),
  short: shortFor({ store: STORE, amount: AMOUNT, contact: CONTACT, language }),
  unmade: unmadeFor({ store: STORE, amount: AMOUNT, contact: CONTACT, language }),
});

async function main(): Promise<void> {
  part("Every non-English store gets all four buyer notices in its own language");
  const english = letters("en");
  for (const language of LANGUAGE_CODES.filter((one) => one !== "en")) {
    const translated = letters(language);
    is(`${language}: closing notice is not the English copy`, JSON.stringify(translated.notice) !== JSON.stringify(english.notice), true);
    is(`${language}: stays-open notice is not the English copy`, JSON.stringify(translated.stays) !== JSON.stringify(english.stays), true);
    is(`${language}: short-refund notice is not the English copy`, JSON.stringify(translated.short) !== JSON.stringify(english.short), true);
    is(`${language}: unmade-refund notice is not the English copy`, JSON.stringify(translated.unmade) !== JSON.stringify(english.unmade), true);
  }

  part("The HTML declares the language used by the buyer notice");
  for (const language of LANGUAGE_CODES) {
    const html = htmlFor(letters(language).notice.text, POSTAL, language);
    is(`${language}: document language`, html.includes(`<html lang="${language}">`), true);
    is(`${language}: article language`, html.includes(`role="article" aria-roledescription="email" lang="${language}"`), true);
  }

  part("The real sender carries the store language into every notice and its HTML");
  const sender = readFileSync("lib/closing-buyers.ts", "utf8");
  is("all four letter calls and the HTML renderer receive store.language", (sender.match(/store\.language/g) ?? []).length >= 5, true);

  part("Controls: translation must preserve every existing policy value");
  is("the product still offers exactly seven store languages", LANGUAGE_CODES.length, 7);
  is("the access sentence keeps the notice period", CLOSING_ACCESS_SENTENCE.includes(`${BUYER_NOTICE_DAYS} days`), true);
  is("the closing notice keeps the store", english.notice.text.includes(STORE), true);
  is("the closing notice keeps the store URL", english.notice.text.includes(STORE_URL), true);
  is("the closing notice keeps the buyer contact", english.notice.text.includes(CONTACT), true);
  is("the closing notice keeps the refund amount", english.notice.text.includes(AMOUNT), true);
  is("the short-refund notice keeps the amount", english.short.text.includes(AMOUNT), true);
  is("the unmade-refund notice keeps the amount", english.unmade.text.includes(AMOUNT), true);
  is("the HTML keeps the postal address", htmlFor(english.notice.text, POSTAL, "en").includes(POSTAL), true);

  done();
}

void main();
