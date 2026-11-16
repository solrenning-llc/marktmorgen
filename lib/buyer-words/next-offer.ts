/**
 * The words of the next product suggested after a purchase
 * (lib/next-offer-rules.ts), in each language a store can speak: on the page
 * after paying and in the confirmation email. The label that says the model
 * chose it is drawn from here, never written by the model.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type NextOfferWords = {
  /** Above a product the creator's own choices led to. */
  label: (store: string) => string;
  /** Above a product the model chose. */
  aiLabel: string;
  /** Under it, every time the model chose. */
  aiNote: (store: string) => string;
  see: string;
  dismiss: string;
  dismissed: string;
  /** When "No thanks" was not kept: the offer stays and can be dismissed again. */
  dismissFailed: string;
  /** In the email, under the suggestion: why this address is shown one. */
  emailConsent: (store: string) => string;
};

const en: NextOfferWords = {
  label: (store) => `More from ${store}`,
  aiLabel: "AI suggestion",
  aiNote: (store) => `Chosen by an AI from ${store}'s own products. The price and terms are ${store}'s, as on its page.`,
  see: "See it",
  dismiss: "No thanks",
  dismissed: "Okay. It won't be suggested again for this order.",
  dismissFailed: "That did not go through, so it may be suggested again. Try again in a moment.",
  emailConsent: (store) => `You see this because you agreed to hear from ${store}.`,
};

const es: NextOfferWords = {
  label: (store) => `Más de ${store}`,
  aiLabel: "Sugerencia de IA",
  aiNote: (store) => `Elegido por una IA entre los productos de ${store}. El precio y las condiciones son los de ${store}, como en su página.`,
  see: "Verlo",
  dismiss: "No, gracias",
  dismissed: "De acuerdo. No se volverá a sugerir para este pedido.",
  dismissFailed: "No se pudo guardar, así que puede volver a sugerirse. Inténtalo de nuevo en un momento.",
  emailConsent: (store) => `Ves esto porque aceptaste recibir noticias de ${store}.`,
};

const fr: NextOfferWords = {
  label: (store) => `Aussi chez ${store}`,
  aiLabel: "Suggestion de l’IA",
  aiNote: (store) => `Choisi par une IA parmi les produits de ${store}. Le prix et les conditions sont ceux de ${store}, comme sur sa page.`,
  see: "Voir",
  dismiss: "Non merci",
  dismissed: "D’accord. Il ne sera plus proposé pour cette commande.",
  dismissFailed: "Cela n’a pas été enregistré, il pourrait donc être proposé à nouveau. Réessayez dans un instant.",
  emailConsent: (store) => `Vous voyez ceci parce que vous avez accepté d’avoir des nouvelles de ${store}.`,
};

const de: NextOfferWords = {
  label: (store) => `Mehr von ${store}`,
  aiLabel: "KI-Vorschlag",
  aiNote: (store) => `Von einer KI unter den eigenen Produkten von ${store} ausgewählt. Preis und Bedingungen sind die von ${store}, wie auf der Produktseite.`,
  see: "Ansehen",
  dismiss: "Nein, danke",
  dismissed: "In Ordnung. Für diese Bestellung wird es nicht mehr vorgeschlagen.",
  dismissFailed: "Das wurde nicht gespeichert, daher kann es wieder vorgeschlagen werden. Versuch es gleich noch einmal.",
  emailConsent: (store) => `Du siehst das, weil du zugestimmt hast, von ${store} zu hören.`,
};

const it: NextOfferWords = {
  label: (store) => `Altro da ${store}`,
  aiLabel: "Suggerimento dell’IA",
  aiNote: (store) => `Scelto da un’IA tra i prodotti di ${store}. Il prezzo e le condizioni sono quelli di ${store}, come sulla sua pagina.`,
  see: "Vedi",
  dismiss: "No, grazie",
  dismissed: "D’accordo. Non sarà più suggerito per questo ordine.",
  dismissFailed: "Non è stato salvato, quindi potrebbe essere suggerito di nuovo. Riprova tra un momento.",
  emailConsent: (store) => `Vedi questo perché hai accettato di ricevere notizie da ${store}.`,
};

const nl: NextOfferWords = {
  label: (store) => `Meer van ${store}`,
  aiLabel: "AI-suggestie",
  aiNote: (store) => `Gekozen door een AI uit de eigen producten van ${store}. De prijs en voorwaarden zijn die van ${store}, zoals op de productpagina.`,
  see: "Bekijken",
  dismiss: "Nee, bedankt",
  dismissed: "Oké. Het wordt voor deze bestelling niet meer voorgesteld.",
  dismissFailed: "Dat is niet opgeslagen, dus het kan opnieuw worden voorgesteld. Probeer het zo meteen opnieuw.",
  emailConsent: (store) => `Je ziet dit omdat je hebt ingestemd om berichten van ${store} te krijgen.`,
};

const pt: NextOfferWords = {
  label: (store) => `Mais de ${store}`,
  aiLabel: "Sugestão de IA",
  aiNote: (store) => `Escolhido por uma IA entre os produtos de ${store}. O preço e as condições são os de ${store}, como na página do produto.`,
  see: "Ver",
  dismiss: "Não, obrigado",
  dismissed: "Certo. Não será sugerido de novo para este pedido.",
  dismissFailed: "Não foi possível salvar, então ele pode ser sugerido de novo. Tente de novo daqui a pouco.",
  emailConsent: (store) => `Você vê isto porque aceitou receber novidades de ${store}.`,
};

export const NEXT_OFFER_WORDS: Record<LanguageCode, NextOfferWords> = { en, es, fr, de, it, nl, pt };

export function nextOfferWords(language: unknown): NextOfferWords {
  return NEXT_OFFER_WORDS[parseLanguage(language)];
}
