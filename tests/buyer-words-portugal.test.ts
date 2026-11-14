/**
 * The store's Portuguese is Portugal's (lib/store-language.ts: pt, locale
 * pt-PT; lib/buyer-words/pt.ts: the courteous third person, "o seu"). Every
 * Portuguese block of lib/buyer-words is read here as source, every branch
 * of it, so a buyer's words never slip into Brazilian Portuguese: no
 * Brazilian word below and no number formatted for Brazil. A file added to
 * lib/buyer-words is read without being named here.
 *
 * Only what is written the same in Portugal is allowed, by its exact line
 * (ALLOWED). Files kept out of this unit by open pull requests or another
 * agent's reservation are listed in WAITING with the words they still have;
 * the test fails when one of them is clean (take it out) or gets worse.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const DIR = join(process.cwd(), "lib/buyer-words");

/** Brazilian words, each with what Portugal says instead (as lib/buyer-words already spells it elsewhere). */
const BRAZILIAN: Record<string, string> = {
  você: "the courteous third person: o seu, a sua, pode",
  vocês: "the courteous third person",
  arquivo: "ficheiro",
  arquivos: "ficheiros",
  equipe: "equipa",
  confira: "verifique",
  celular: "telemóvel",
  tela: "ecrã",
  salvar: "guardar",
  salve: "guarde",
  salvando: "a guardar",
  baixar: "transferir",
  baixe: "transfira",
  baixá: "transferi-…",
  carregando: "a carregar",
  enviando: "a enviar",
  esperando: "a aguardar",
  conexão: "ligação",
  aceitos: "aceites",
  recado: "nota, mensagem",
  senha: "palavra-passe",
  cadastro: "registo",
  usuário: "utilizador",
  usuários: "utilizadores",
};

/** Lines written the same in Portugal, exactly as they stand. */
const ALLOWED = new Set([
  // The label over the buyer's own messages in a chat: a name for the reader, not a way of addressing them.
  'you: "Você",',
]);

/** Files with Portuguese still to fix, kept out by open pull requests or a reservation, and the words each still has. */
const WAITING: Record<string, string[]> = {
  // Open pull requests #3376, #3409, #3473, #3518 and #3530 change this file.
  "courses.ts": ["você", "tela"],
  // Reserved by Codex O (docs/reservations/codex.md).
  "community.ts": ["confira"],
};

/** The Portuguese of a words file, as source: `const pt … = {` (or `export const pt`) to its closing `};`, and every one-line `pt:` entry. */
function portugueseOf(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^(export )?const pt\b/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j]); j += 1) out.push(lines[j].trim());
    } else if (/^\s+pt: /.test(lines[i])) out.push(lines[i].trim().replace(/^pt: /, ""));
  }
  return out;
}

const pattern = (word: string) => new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, "iu");

/** The Brazilian words in a file's Portuguese, outside the allowed lines. */
function brazilianIn(source: string): string[] {
  const lines = portugueseOf(source).filter((line) => !ALLOWED.has(line) && !line.startsWith("//") && !line.startsWith("*"));
  return Object.keys(BRAZILIAN).filter((word) => lines.some((line) => pattern(word).test(line)));
}

function main(): void {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

  part("The scan reads what it says");
  is("it finds a Brazilian word in a block", brazilianIn('const pt: W = {\n  a: "Você já tem um arquivo.",\n};\n'), ["você", "arquivo"]);
  is("in a one-line entry", brazilianIn('  pt: "Confira a sua equipe",\n'), ["equipe", "confira"]);
  is("in every branch of a function", brazilianIn('const pt: W = {\n  a: (n) => (n === 1 ? "um ficheiro" : "Baixe os arquivos"),\n};\n'), ["arquivos", "baixe"]);
  is("never inside another word", brazilianIn('const pt: W = {\n  a: "Os ficheiros aceites e a ligação ao telemóvel; telas no ecrã? não: estelar.",\n};\n'), []);
  is("other languages are not read", brazilianIn('const es: W = {\n  a: "arquivo",\n};\n'), []);
  is("every words file with Portuguese is read", files.filter((f) => !["index.ts", "en.ts", "es.ts", "fr.ts", "de.ts", "it.ts", "nl.ts"].includes(f)).every((f) => portugueseOf(readFileSync(join(DIR, f), "utf8")).length > 0), true);

  part("Every buyer's Portuguese is Portugal's");
  const found: Record<string, string[]> = {};
  for (const file of files) {
    const words = brazilianIn(readFileSync(join(DIR, file), "utf8"));
    if (words.length) found[file] = words;
  }
  const fixed = Object.fromEntries(Object.entries(found).filter(([file]) => !Object.hasOwn(WAITING, file)));
  is("no Brazilian word outside the files still waiting", fixed, {});
  for (const [file, words] of Object.entries(WAITING)) {
    is(`${file} still waits with exactly these, never more (take it out of WAITING once it is clean)`, found[file] ?? [], words);
  }
  is("no number is formatted for Brazil", files.filter((f) => readFileSync(join(DIR, f), "utf8").includes('"pt-BR"')), []);
  done();
}

main();
