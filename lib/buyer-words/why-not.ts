/**
 * The question on a product's sales page to a visitor about to go without
 * buying (components/page-depth.tsx), in each language a store can speak.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import type { WhyNot } from "@/lib/why-not-rules";

export type WhyNotWords = { question: string; note: string; choices: Record<WhyNot, string>; thanks: string; close: string };

const en: WhyNotWords = {
  question: "Before you go: is anything stopping you from buying?",
  note: "One tap, and it helps make this page better. Nothing about you is kept.",
  choices: { price: "The price", fit: "Not sure it's for me", details: "I need more details", later: "I'll decide later", other: "Something else" },
  thanks: "Thank you.",
  close: "Close",
};
const es: WhyNotWords = {
  question: "Antes de irte: ¿hay algo que te impida comprar?",
  note: "Un toque, y ayuda a mejorar esta página. No se guarda nada sobre ti.",
  choices: { price: "El precio", fit: "No sé si es para mí", details: "Necesito más detalles", later: "Lo decidiré más tarde", other: "Otra cosa" },
  thanks: "Gracias.",
  close: "Cerrar",
};
const fr: WhyNotWords = {
  question: "Avant de partir : quelque chose vous retient-il d’acheter ?",
  note: "Un clic, et cela aide à améliorer cette page. Rien sur vous n’est gardé.",
  choices: { price: "Le prix", fit: "Je ne sais pas si c’est pour moi", details: "J’ai besoin de plus de détails", later: "Je déciderai plus tard", other: "Autre chose" },
  thanks: "Merci.",
  close: "Fermer",
};
const de: WhyNotWords = {
  question: "Bevor Sie gehen: Hält Sie etwas vom Kauf ab?",
  note: "Ein Klick, und es hilft, diese Seite zu verbessern. Über Sie wird nichts gespeichert.",
  choices: { price: "Der Preis", fit: "Ich weiß nicht, ob es zu mir passt", details: "Ich brauche mehr Details", later: "Ich entscheide später", other: "Etwas anderes" },
  thanks: "Danke.",
  close: "Schließen",
};
const it: WhyNotWords = {
  question: "Prima di andare: c'è qualcosa che ti trattiene dall'acquisto?",
  note: "Un tocco, e aiuta a migliorare questa pagina. Non viene conservato nulla su di te.",
  choices: { price: "Il prezzo", fit: "Non so se fa per me", details: "Mi servono più dettagli", later: "Deciderò più tardi", other: "Altro" },
  thanks: "Grazie.",
  close: "Chiudi",
};
const nl: WhyNotWords = {
  question: "Voordat je gaat: houdt iets je tegen om te kopen?",
  note: "Eén tik, en het helpt deze pagina beter te maken. Er wordt niets over jou bewaard.",
  choices: { price: "De prijs", fit: "Ik weet niet of het iets voor mij is", details: "Ik heb meer details nodig", later: "Ik beslis later", other: "Iets anders" },
  thanks: "Bedankt.",
  close: "Sluiten",
};
const pt: WhyNotWords = {
  question: "Antes de sair: há alguma coisa que o impeça de comprar?",
  note: "Um toque, e ajuda a melhorar esta página. Nada sobre si é guardado.",
  choices: { price: "O preço", fit: "Não sei se é para mim", details: "Preciso de mais detalhes", later: "Vou decidir mais tarde", other: "Outra coisa" },
  thanks: "Obrigado.",
  close: "Fechar",
};

export const WHY_NOT_WORDS: Record<LanguageCode, WhyNotWords> = { en, es, fr, de, it, nl, pt };

export function whyNotWords(language: unknown): WhyNotWords {
  return WHY_NOT_WORDS[parseLanguage(language)];
}
