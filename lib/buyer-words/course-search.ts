/**
 * The words of "Find a lesson" on a course's front door
 * (components/course-search.tsx, lib/course-search.ts), in the store's
 * language (lib/store-language.ts). Every language says all English says,
 * nothing added and nothing softened, with the same form of address as the
 * rest of the course's words (lib/buyer-words/courses.ts).
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type CourseSearchWords = {
  /** The field's visible label. */
  label: string;
  /** Under the field before anything is typed. */
  idle: string;
  /** When no lesson is left. */
  none: string;
  /** How many lessons are left, of how many. */
  some: (matches: number, total: number) => string;
  /** The button that empties the field and shows every lesson again. */
  clear: string;
};

const en: CourseSearchWords = {
  label: "Find a lesson",
  idle: "Type a word from a lesson or module title. The list below then shows only the lessons that match.",
  none: "No lesson title has those words. Try another word, or clear the search.",
  some: (n, total) =>
    n === 1 ? `1 of ${total} lessons matches. It is in the list below.` : `${n} of ${total} lessons match. They are in the list below.`,
  clear: "Clear the search",
};

const es: CourseSearchWords = {
  label: "Buscar una lección",
  idle: "Escribe una palabra del título de una lección o de un módulo. La lista de abajo mostrará solo las lecciones que coinciden.",
  none: "Ningún título de lección tiene esas palabras. Prueba con otra palabra o borra la búsqueda.",
  some: (n, total) =>
    n === 1 ? `1 de ${total} lecciones coincide. Está en la lista de abajo.` : `${n} de ${total} lecciones coinciden. Están en la lista de abajo.`,
  clear: "Borrar la búsqueda",
};

const fr: CourseSearchWords = {
  label: "Trouver une leçon",
  idle: "Saisissez un mot du titre d'une leçon ou d'un module. La liste ci-dessous ne montrera que les leçons qui correspondent.",
  none: "Aucun titre de leçon ne contient ces mots. Essayez un autre mot ou effacez la recherche.",
  some: (n, total) =>
    n === 1 ? `1 leçon sur ${total} correspond. Elle est dans la liste ci-dessous.` : `${n} leçons sur ${total} correspondent. Elles sont dans la liste ci-dessous.`,
  clear: "Effacer la recherche",
};

const de: CourseSearchWords = {
  label: "Lektion finden",
  idle: "Geben Sie ein Wort aus dem Titel einer Lektion oder eines Moduls ein. Die Liste unten zeigt dann nur die passenden Lektionen.",
  none: "Kein Lektionstitel enthält diese Wörter. Versuchen Sie ein anderes Wort, oder löschen Sie die Suche.",
  some: (n, total) =>
    n === 1 ? `1 von ${total} Lektionen passt. Sie steht in der Liste unten.` : `${n} von ${total} Lektionen passen. Sie stehen in der Liste unten.`,
  clear: "Suche löschen",
};

const it: CourseSearchWords = {
  label: "Trova una lezione",
  idle: "Scrivi una parola del titolo di una lezione o di un modulo. L'elenco qui sotto mostrerà solo le lezioni che corrispondono.",
  none: "Nessun titolo di lezione contiene queste parole. Prova un'altra parola o cancella la ricerca.",
  some: (n, total) =>
    n === 1 ? `1 lezione su ${total} corrisponde. È nell'elenco qui sotto.` : `${n} lezioni su ${total} corrispondono. Sono nell'elenco qui sotto.`,
  clear: "Cancella la ricerca",
};

const nl: CourseSearchWords = {
  label: "Een les zoeken",
  idle: "Typ een woord uit de titel van een les of module. De lijst hieronder toont dan alleen de lessen die passen.",
  none: "Geen enkele lestitel bevat die woorden. Probeer een ander woord, of wis de zoekopdracht.",
  some: (n, total) =>
    n === 1 ? `1 van de ${total} lessen past. Hij staat in de lijst hieronder.` : `${n} van de ${total} lessen passen. Ze staan in de lijst hieronder.`,
  clear: "Zoekopdracht wissen",
};

const pt: CourseSearchWords = {
  label: "Procurar uma aula",
  idle: "Escreva uma palavra do título de uma aula ou de um módulo. A lista abaixo passa a mostrar só as aulas que correspondem.",
  none: "Nenhum título de aula tem essas palavras. Experimente outra palavra ou limpe a pesquisa.",
  some: (n, total) =>
    n === 1 ? `1 de ${total} aulas corresponde. Está na lista abaixo.` : `${n} de ${total} aulas correspondem. Estão na lista abaixo.`,
  clear: "Limpar a pesquisa",
};

export const COURSE_SEARCH_WORDS: Record<LanguageCode, CourseSearchWords> = { en, es, fr, de, it, nl, pt };

export function courseSearchWords(language: unknown): CourseSearchWords {
  return COURSE_SEARCH_WORDS[parseLanguage(language)];
}
