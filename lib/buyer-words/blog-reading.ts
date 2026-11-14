import { parseLanguage, type LanguageCode } from "@/lib/store-language";

const WORDS: Record<LanguageCode, { unavailable: string; retry: string }> = {
 en: { unavailable: "The blog could not be read right now. Try again in a moment. This does not mean there are no posts.", retry: "Try again" },
 es: { unavailable: "No se ha podido leer el blog en este momento. Inténtalo de nuevo en un momento. Esto no significa que no haya publicaciones.", retry: "Intentar de nuevo" },
 fr: { unavailable: "Le blog n’a pas pu être lu pour le moment. Réessayez dans un instant. Cela ne signifie pas qu’il n’y a aucune publication.", retry: "Réessayer" },
 de: { unavailable: "Der Blog konnte gerade nicht gelesen werden. Versuche es gleich noch einmal. Das bedeutet nicht, dass es keine Beiträge gibt.", retry: "Erneut versuchen" },
 it: { unavailable: "Al momento non è stato possibile leggere il blog. Riprova tra poco. Questo non significa che non ci siano articoli.", retry: "Riprova" },
 nl: { unavailable: "De blog kon nu niet worden gelezen. Probeer het zo opnieuw. Dit betekent niet dat er geen berichten zijn.", retry: "Opnieuw proberen" },
 pt: { unavailable: "Não foi possível ler o blog agora. Tente novamente em instantes. Isso não significa que não há publicações.", retry: "Tentar novamente" },
};

export function blogReadingWords(language: unknown): { unavailable: string; retry: string } {
 return WORDS[parseLanguage(language)];
}
