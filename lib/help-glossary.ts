/**
 * The unusual words the help center's answers use, and what each means
 * (564 [HC1] item 5, WCAG 3.1.3 Unusual Words; added 12 November 2026). Each
 * answer's own page lists, under "Words in this answer", the terms its words
 * contain, so a reader never has to leave the answer to learn one.
 *
 * `words` finds the term in an answer, as whole words only, so "lead to" is
 * never taken for a lead. tests/help-glossary.test.ts fails when a term is
 * used by no answer, when two terms share a name, or when a meaning that
 * another page of the site already gives for the same word says something
 * else. Browser-safe: plain data.
 */

export type HelpTerm = { term: string; meaning: string; words: RegExp };

export const HELP_TERMS: readonly HelpTerm[] = [
  { term: "API key", meaning: "A long secret code that lets another program read or change your store for you. Anyone who has it can use it, so keep it private.", words: /\bAPI keys?\b/i },
  { term: "Catch Hook", meaning: "Zapier's name for an address that waits for messages from another service, such as your store's webhooks.", words: /\bCatch Hook\b/ },
  { term: "Chargeback", meaning: "Money a bank takes back from you after a buyer disputes a payment with it.", words: /\bchargebacks?\b/i },
  { term: "Cookie", meaning: "A small note a website asks your browser to keep, and that the browser sends back on the next visit.", words: /\bcookies?\b/i },
  { term: "CSV file", meaning: "A spreadsheet saved as plain text, with one row on each line.", words: /\bCSV\b/ },
  { term: "Dispute", meaning: "When a buyer asks their bank to take back a payment. The bank holds the money until it decides.", words: /\bdisput(?:e|es|ed|ing)\b/i },
  { term: "Endpoint", meaning: "The web address that receives your store's webhook messages.", words: /\bendpoints?\b/i },
  { term: "EPUB", meaning: "The file format most e-book readers open, such as Apple Books.", words: /\bEPUB\b/ },
  { term: "Funnel", meaning: "Pages in a set order that lead a visitor from a first offer to a purchase.", words: /\bfunnels?\b/i },
  { term: "HMAC-SHA256", meaning: "A way to sign a message with a secret key, so the receiver can check that it came from us and was not changed on the way.", words: /\bHMAC(?:-SHA256)?\b/ },
  { term: "HTML", meaning: "The code web pages and many emails are written in.", words: /\bHTML\b/ },
  { term: "HTTPS", meaning: "A web address that starts with https://, whose connection is encrypted.", words: /\bhttps\b/i },
  { term: "iCal", meaning: "The calendar file format that Google, Outlook and Apple calendars all read.", words: /\biCal\b/ },
  { term: "JSON", meaning: "A plain-text format for data that other programs read easily.", words: /\bJSON\b/ },
  { term: "License key", meaning: "A unique code each buyer gets with a purchase, usually to unlock software, never given to two buyers.", words: /\blicen[cs]e keys?\b/i },
  { term: "Passkey", meaning: "A way to sign in with the face, fingerprint or PIN that unlocks your phone or computer. Your device keeps the private part of the key; we keep only the public part.", words: /\bpasskeys?\b/i },
  { term: "Payout", meaning: "Money sent out of a payment account: Stripe paying your balance into your bank, or your PayPal paying an affiliate.", words: /\bpayouts?\b/i },
  { term: "Pipeline", meaning: "The stages a deal goes through, from the first conversation to won or lost.", words: /\bpipelines?\b/i },
  { term: "Pixel", meaning: "A small piece of code from an ad platform, such as Meta, Google, TikTok or Pinterest, that tells it what visitors view and buy, so your ads can learn who buys.", words: /\bpixels?\b/i },
  { term: "Sequence", meaning: "Emails that go out by themselves, one after another, hours or days after someone joins or buys.", words: /\bsequences?\b/i },
  { term: "Signing secret", meaning: "A secret code shared by your store and the address that gets its webhooks, used to check that each message came from your store.", words: /\bsigning secrets?\b/i },
  { term: "Two-step login", meaning: "Signing in with two things instead of one: the link sent to your email, and a six-digit code from an authenticator app on your phone.", words: /\btwo-step\b/i },
  { term: "UTC", meaning: "Coordinated Universal Time: one clock used for dates around the world.", words: /\bUTC\b/ },
  { term: "VAT", meaning: "Value-added tax: a tax on sales charged in the European Union, the United Kingdom and many other countries.", words: /\bVAT\b/ },
  { term: "Webhook", meaning: "A message our server sends to an address you choose when something happens in your store.", words: /\bwebhooks?\b/i },
  { term: "Workflow", meaning: "A sequence that can do more than send email: wait, branch on a condition, add a label or move a deal.", words: /\bworkflows?\b/i },
];

/** The terms one answer's words use, in alphabetical order. */
export function termsIn(text: string): HelpTerm[] {
  return HELP_TERMS.filter((t) => t.words.test(text)).sort((a, b) => a.term.localeCompare(b.term, "en-US"));
}
