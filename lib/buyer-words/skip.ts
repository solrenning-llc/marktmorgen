/**
 * The skip link drawn around every page of a store (app/[handle]/layout.tsx,
 * components/skip-link.tsx), the first thing a keyboard reaches, in each
 * language a store can speak, with the locale it is marked with: the root
 * <html> is lang="en-US", so the link carries its own lang (WCAG 3.1.2).
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

export const SKIP_WORDS: Record<LanguageCode, string> = {
  en: "Skip to the page content",
  es: "Saltar al contenido de la página",
  fr: "Aller au contenu de la page",
  de: "Zum Seiteninhalt springen",
  it: "Vai al contenuto della pagina",
  nl: "Ga naar de inhoud van de pagina",
  pt: "Saltar para o conteúdo da página",
};

/** The store's words for the skip link, and the locale its lang is marked with. */
export function skipWords(language: unknown): { label: string; lang: string } {
  const code = parseLanguage(language);
  return { label: SKIP_WORDS[code], lang: LANGUAGES[code].locale };
}
