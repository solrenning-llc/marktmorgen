/**
 * The button that stops a store's Aurora backdrop drifting (components/backdrop-pause.tsx, drawn around every page of
 * a store by app/[handle]/layout.tsx; WCAG 2.2.2), in each language a store can speak, with the locale it is marked
 * with: the root <html> is lang="en-US", so the button carries its own lang (WCAG 3.1.2).
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

export type BackdropPauseWords = { pause: string; play: string };

export const BACKDROP_PAUSE_WORDS: Record<LanguageCode, BackdropPauseWords> = {
  en: { pause: "Pause background motion", play: "Play background motion" },
  es: { pause: "Pausar el movimiento del fondo", play: "Reanudar el movimiento del fondo" },
  fr: { pause: "Mettre en pause le mouvement de l’arrière-plan", play: "Reprendre le mouvement de l’arrière-plan" },
  de: { pause: "Hintergrundbewegung anhalten", play: "Hintergrundbewegung fortsetzen" },
  it: { pause: "Metti in pausa il movimento dello sfondo", play: "Riprendi il movimento dello sfondo" },
  nl: { pause: "Beweging van de achtergrond pauzeren", play: "Beweging van de achtergrond hervatten" },
  pt: { pause: "Pausar o movimento do fundo", play: "Retomar o movimento do fundo" },
};

/** The store's words for the button, and the locale its lang is marked with. */
export function backdropPauseWords(language: unknown): BackdropPauseWords & { lang: string } {
  const code = parseLanguage(language);
  return { ...BACKDROP_PAUSE_WORDS[code], lang: LANGUAGES[code].locale };
}
