/**
 * The words of the "Certificates earned" number in a sales page's "By the numbers" block (lib/page-facts.ts,
 * 93 [D2-VERIFIED-SOCIAL], unit 1): exactly what was counted, how many students hold the course's certificate,
 * never "students", "graduates" or "happy customers". Said from ten up, so the singular is there only for
 * completeness. Browser-safe: plain data.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French counts 0 and 1 as singular. */
const frPlural = (n: number, one: string, many: string) => (n < 2 ? one : many);

export const FINISHED_WORDS: Record<LanguageCode, (n: number) => string> = {
  en: (n) => plural(n, "student earned the certificate", "students earned the certificate"),
  es: (n) => plural(n, "estudiante obtuvo el certificado", "estudiantes obtuvieron el certificado"),
  fr: (n) => frPlural(n, "participant a obtenu le certificat", "participants ont obtenu le certificat"),
  de: (n) => plural(n, "teilnehmende Person hat das Zertifikat erhalten", "Teilnehmende haben das Zertifikat erhalten"),
  it: (n) => plural(n, "studente ha ottenuto il certificato", "studenti hanno ottenuto il certificato"),
  nl: (n) => plural(n, "cursist behaalde het certificaat", "cursisten behaalden het certificaat"),
  pt: (n) => plural(n, "aluno obteve o certificado", "alunos obtiveram o certificado"),
};

export function finishedWords(language: unknown): (n: number) => string {
  return FINISHED_WORDS[parseLanguage(language)];
}
