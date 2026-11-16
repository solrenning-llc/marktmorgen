/**
 * A fair price says it was personalised by an automated decision (EU
 * Consumer Rights Directive 2011/83/EU Art. 6(1)(ea), inserted by Directive
 * (EU) 2019/2161 Art. 4(4): "where applicable, that the price was
 * personalised on the basis of automated decision-making";
 * docs/eu-consumer-audit-2026-11-06.md, row 9 and unit 5).
 *
 * The fair price (lib/fair-price.ts) lowers a product's price from the
 * country read automatically from the visitor's internet connection
 * (lib/visitor.ts). The note under it (`fairNote`, drawn by SaleNote in
 * components/store-product.tsx) must say, in each of the seven buyer
 * languages, that this price was set automatically for the person looking,
 * from the country of their connection. Nothing about the price or its rule
 * changes.
 */
import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { done, is, part } from "./check";

const STORE = "Kiln Works";

/** Per language: the word for "automatically", "for you" (as that file addresses buyers) and the connection. */
const SAYS = {
  en: { automatic: "set automatically", you: "for you", source: "internet connection" },
  es: { automatic: "automáticamente", you: "para ti", source: "conexión a internet" },
  fr: { automatic: "automatiquement", you: "pour vous", source: "connexion internet" },
  de: { automatic: "automatisch", you: "für Sie", source: "Internetverbindung" },
  it: { automatic: "automaticamente", you: "per te", source: "connessione internet" },
  nl: { automatic: "automatisch", you: "voor jou", source: "internetverbinding" },
  pt: { automatic: "automaticamente", you: "para si", source: "ligação à internet" },
} as const;

part("Each language says the price was set automatically for this visitor");
for (const [language, says] of Object.entries(SAYS) as [keyof typeof SAYS, (typeof SAYS)[keyof typeof SAYS]][]) {
  const w = wordsIn(language);
  for (const plan of [false, true]) {
    const note = w.fairNote(STORE, plan);
    const label = `${language}${plan ? ", with a payment plan" : ""}`;
    is(`${label}: says it was set automatically`, note.includes(says.automatic), true);
    is(`${label}: says it was set for the person looking`, note.includes(says.you), true);
    is(`${label}: says it comes from their internet connection`, note.includes(says.source), true);
    is(`${label}: still names the store`, note.includes(STORE), true);
  }
  is(`${language}: the payment-plan words still differ`, w.fairNote(STORE, true) !== w.fairNote(STORE, false), true);
}

part("The note is drawn under the fair price");
const product = readFileSync("components/store-product.tsx", "utf8");
is("SaleNote draws fairNote right under fairHead", /w\.fairHead\([^)]*\)[^\n]*\)\}\s*<span[^>]*>\{w\.fairNote\(store\.name/.test(product), true);

done();
