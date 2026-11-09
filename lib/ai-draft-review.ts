/**
 * What the creator checks under every AI draft before it is saved (756 [STN3],
 * unit 1). The writing box (components/ai-assist.tsx) marks what it filled in
 * as an "AI draft", in words, and lists three checks; a form that saves the
 * draft waits until all three are checked (components/product-editor.tsx).
 * Pure rules: nothing here calls a model, reads or writes anything.
 */

/** The badge drawn by the page over every draft the writing help fills in, never by the model. */
export const AI_DRAFT_BADGE = "AI draft";

/** The three things the creator confirms, in plain words: the facts, any picture, the price and numbers. */
export const AI_DRAFT_CHECKS: readonly { id: "facts" | "picture" | "price"; label: string }[] = [
  { id: "facts", label: "Every fact in it is true, and it says only what you offer." },
  { id: "picture", label: "If there is a picture, it fits what it says." },
  { id: "price", label: "The price and every number in it are right." },
];

/** What the form says when it is asked to save while a draft is not checked yet. */
export const AI_DRAFT_HOLD = "This has an AI draft you have not checked yet. Check the three boxes under it, then save.";

/** A new draft: none checked. */
export function freshChecks(): boolean[] {
  return AI_DRAFT_CHECKS.map(() => false);
}

/** All three checked, and only then; a list of any other length is never done. */
export function reviewDone(checks: readonly boolean[]): boolean {
  return checks.length === AI_DRAFT_CHECKS.length && checks.every((ticked) => ticked === true);
}

/** The first check left, or -1 when none is. */
export function firstUnchecked(checks: readonly boolean[]): number {
  return checks.findIndex((ticked) => ticked !== true);
}

/** Why a save waits: null when no draft is waiting (`null`) or it is checked, the sentence otherwise. */
export function aiDraftHold(checks: readonly boolean[] | null): string | null {
  if (checks === null) return null;
  return reviewDone(checks) ? null : AI_DRAFT_HOLD;
}

/** A subject where a wrong sentence can hurt someone, so an AI draft about it asks for a reader who knows it (756 [STN3], unit 2). */
export type SensitiveTopic = "health" | "money" | "law";

/**
 * What a draft is about: its subjects, or "unread" when it is written in a
 * language the word lists below do not read, so the warning is the general
 * one rather than none (Claude 6's review of #3436).
 */
export type DraftTopics = readonly SensitiveTopic[] | "unread";

/** Every piece of text a draft holds, at any depth; numbers and keys are settings, never claims, so they are left out. */
export function draftStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(draftStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(draftStrings);
  return [];
}

/**
 * Whole words only, any case: "lawn", "outlaw", "treaty" or "curious" are never
 * taken for one. Words that mostly mean something else in a product draft are
 * left out or read only in the phrase that is about the subject: "treats"
 * (dog treats), "cured" (cured meats), "stock" (stock photos, chicken stock),
 * "earn" (earn a certificate), "license" (a font's commercial license),
 * "court" (a basketball court), "money-back" (a guarantee), "taxing" (a
 * taxing workout). Sale wording is not a subject either: "save money",
 * "big savings", "savings on", "while stocks last", "trading cards",
 * "treated wood" (or with care, like, to), "the law of attraction".
 */
const TOPIC_WORDS: Record<SensitiveTopic, RegExp> = {
  health: /\b(health|medical|medicine|medications?|doctors?|nurses?|diagnos(e|es|is|ed|ing)|diseases?|illness(es)?|disorders?|symptoms?|cures?|(?<!(pressure|heat)-)treated(?! (wood|lumber|timber|pine|cedar|glass|steel|leather|fabric|paper|water|with care|like|to)\b)|treat(ing|ments?)|therap(y|ies)|therapists?|diet(s|ing)?|weight[- ]loss|pregnan(cy|t)|supplements?|anxiety|depression|injur(y|ies)|cancer|(chronic|back|joint|neck) pain|pain relief|heal(s|ed|ing)|trauma)\b/i,
  money: /\b((?<!\b(save|saves|saved|saving) )money(?![- ]back)|financ(e|es|ial|ially)|invest(s|ed|ing|ment|ments|or|ors)?|trading(?! cards?\b)|stocks(?! last\b)|stock (market|trading)|crypto|bitcoin|forex|income|profits?|earnings|retire(d|ment)?|(?<!\b(big|bigger|huge|great|extra|instant|bundle) )savings(?! on\b)|loans?|debts?|mortgages?|tax(es|ed)?|credit scores?|passive income)\b/i,
  law: /\b(law(?! of (attraction|averages)\b)|laws|legal(ly)?|lawyers?|attorneys?|contracts?|lawsuits?|sue|sued|suing|(in|to|before) court|courtrooms?|court (case|order|date|hearing)s?|visas?|immigration|copyrights?|trademarks?)\b/i,
};

const TOPIC_ORDER: SensitiveTopic[] = ["health", "money", "law"];

/** The subjects a text, or any one of several, is about, in a fixed order; none for anything else. */
export function sensitiveTopics(text: string | readonly string[]): SensitiveTopic[] {
  const texts = typeof text === "string" ? [text] : text;
  return TOPIC_ORDER.filter((topic) => texts.some((one) => TOPIC_WORDS[topic].test(one)));
}

/**
 * The store languages the word lists read. A draft is written in the store's
 * language (lib/ai.ts, storeLanguage); lists in the other store languages
 * would miss their own wording without a native reader to write them, so a
 * draft in any of those, or in a language not said, gets the general warning.
 */
const READ_LANGUAGES: ReadonlySet<string> = new Set(["en"]);

/** What a draft's own strings are about, read in its language (756 [STN3], unit 2). */
export function draftTopics(texts: readonly string[], language: string | null | undefined): DraftTopics {
  if (!language || !READ_LANGUAGES.has(language)) return "unread";
  return sensitiveTopics(texts);
}

const TOPIC_WORDS_SAID: Record<SensitiveTopic, string> = { health: "health", money: "money", law: "the law" };
const TOPIC_READER: Record<SensitiveTopic, string> = { health: "a doctor", money: "an accountant", law: "a lawyer" };

const listed = (words: readonly string[], last: "and" | "or") =>
  words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;

/** The label drawn before the warning, in bold. */
export function sensitiveLabel(topics: DraftTopics): string {
  return topics === "unread" ? "Health, money or the law:" : "Sensitive topic:";
}

/** What the checks say about those subjects, or null when there are none. */
export function sensitiveWarning(topics: DraftTopics): string | null {
  if (topics === "unread") {
    return "If this draft is about health, money or the law, have someone who knows the subject read it before you publish, such as a doctor, an accountant or a lawyer, and do not promise a result. We look for these subjects only in drafts written in English.";
  }
  if (!topics.length) return null;
  const subjects = listed(topics.map((topic) => TOPIC_WORDS_SAID[topic]), "and");
  const readers = listed(topics.map((topic) => TOPIC_READER[topic]), "or");
  const subject = topics.length === 1 ? "the subject" : "each subject";
  return `This draft is about ${subjects}. Before you publish, have someone who knows ${subject} read it, such as ${readers}, and do not promise a result.`;
}

/** The badge drawn by the page beside each number in an AI draft that the creator did not give (756 [STN3], unit 3). */
export const ESTIMATE_BADGE = "Estimate";

/** What the list under the badges says: what to do, and what it reads, so an empty list is never taken for "no invented numbers". */
export const ESTIMATE_NOTE =
  "These numbers are not in what you gave. Check each one, or change it to a figure you know. We find numbers written in digits and common number words, such as twenty, a dozen or half, but not every way to write one, so read the rest of the draft too.";

/** A key that names an id, never a value the creator typed: "id", "lessonId", "productIds". */
const ID_KEY = /^(id|ids)$|Ids?$/;

/** A value shaped like an id: one long run of letters and digits, both in it, no space (lib/store.ts, randomUUID). */
const looksLikeId = (value: string) => value.length >= 16 && /^[A-Za-z0-9_-]+$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);

/**
 * What the creator gave a job besides its notes: the text values it was sent
 * with (a title, a price, a goal) and its numeric settings (how many
 * questions), at any depth. Ids are left out, by their key and by their shape,
 * so the digits inside one are never taken for a number the creator gave
 * (Claude 6's review of #3437).
 */
export function givenTexts(sent: unknown, key = ""): string[] {
  if (ID_KEY.test(key)) return [];
  if (typeof sent === "string") return looksLikeId(sent) ? [] : [sent];
  if (typeof sent === "number") return Number.isFinite(sent) ? [String(sent)] : [];
  if (Array.isArray(sent)) return sent.flatMap((one) => givenTexts(one, key));
  if (sent && typeof sent === "object") return Object.entries(sent).flatMap(([name, one]) => givenTexts(one, name));
  return [];
}

/**
 * A number in digits: a currency sign, digits with thousands or decimal
 * separators, then a percent sign or a K, M or B. Never right after a letter,
 * a digit or a separator, so the digits inside a word or an id are not one.
 */
const DIGITS = /(?<![\p{L}\p{N}_.,])[$€£]?\d+(?:[.,]\d+)*(?:\s?%|[kKmMbB](?![\p{L}\p{N}]))?/gu;

/** Number words, by store language, with what each stands for: a number, or "×2" and "½". */
type Words = readonly (readonly [string, number | string])[];

/**
 * Common number words only. Left out on purpose: "one" and its kin in every
 * language (a word every sentence uses), and words that mostly mean something
 * else: French "neuf" (new) and "cent" (in "pour cent"), Italian "sei" (you
 * are) and "cento" (in "per cento"). Words joined into one (German
 * "fünfundzwanzig") are not read; English ones joined by a hyphen or with
 * "hundred", "thousand" or "million" after them are.
 */
const ENGLISH_UNITS: Words = [["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9]];
const ENGLISH_TENS: Words = [["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]];
const ENGLISH: Words = [
  ...ENGLISH_UNITS,
  ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19],
  ...ENGLISH_TENS,
  ["hundreds", "hundreds"], ["thousands", "thousands"], ["millions", "millions"], ["dozens", "dozens"],
  ["half a dozen", 6], ["a dozen", 12], ["dozen", 12], ["double", "×2"], ["twice", "×2"], ["triple", "×3"], ["half", "½"],
];
const NUMBER_WORDS: Record<string, Words> = {
  en: ENGLISH,
  es: [["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5], ["seis", 6], ["siete", 7], ["ocho", 8], ["nueve", 9], ["diez", 10], ["once", 11], ["doce", 12], ["trece", 13], ["catorce", 14], ["quince", 15], ["dieciséis", 16], ["diecisiete", 17], ["dieciocho", 18], ["diecinueve", 19], ["veinte", 20], ["treinta", 30], ["cuarenta", 40], ["cincuenta", 50], ["sesenta", 60], ["setenta", 70], ["ochenta", 80], ["noventa", 90], ["cien", 100], ["mil", 1000], ["millón", 1_000_000], ["millones", "millions"], ["docena", 12], ["doble", "×2"], ["mitad", "½"]],
  fr: [["deux", 2], ["trois", 3], ["quatre", 4], ["cinq", 5], ["six", 6], ["sept", 7], ["huit", 8], ["dix", 10], ["onze", 11], ["douze", 12], ["treize", 13], ["quatorze", 14], ["quinze", 15], ["seize", 16], ["vingt", 20], ["trente", 30], ["quarante", 40], ["cinquante", 50], ["soixante", 60], ["mille", 1000], ["million", 1_000_000], ["millions", "millions"], ["douzaine", 12], ["double", "×2"], ["moitié", "½"]],
  de: [["zwei", 2], ["drei", 3], ["vier", 4], ["fünf", 5], ["sechs", 6], ["sieben", 7], ["acht", 8], ["neun", 9], ["zehn", 10], ["elf", 11], ["zwölf", 12], ["dreizehn", 13], ["vierzehn", 14], ["fünfzehn", 15], ["sechzehn", 16], ["siebzehn", 17], ["achtzehn", 18], ["neunzehn", 19], ["zwanzig", 20], ["dreißig", 30], ["vierzig", 40], ["fünfzig", 50], ["sechzig", 60], ["siebzig", 70], ["achtzig", 80], ["neunzig", 90], ["hundert", 100], ["tausend", 1000], ["million", 1_000_000], ["millionen", "millions"], ["dutzend", 12], ["doppelt", "×2"], ["hälfte", "½"]],
  it: [["due", 2], ["tre", 3], ["quattro", 4], ["cinque", 5], ["sette", 7], ["otto", 8], ["nove", 9], ["dieci", 10], ["undici", 11], ["dodici", 12], ["venti", 20], ["trenta", 30], ["quaranta", 40], ["cinquanta", 50], ["sessanta", 60], ["settanta", 70], ["ottanta", 80], ["novanta", 90], ["mille", 1000], ["milione", 1_000_000], ["milioni", "millions"], ["dozzina", 12], ["doppio", "×2"], ["metà", "½"]],
  nl: [["twee", 2], ["drie", 3], ["vier", 4], ["vijf", 5], ["zes", 6], ["zeven", 7], ["acht", 8], ["negen", 9], ["tien", 10], ["elf", 11], ["twaalf", 12], ["twintig", 20], ["dertig", 30], ["veertig", 40], ["vijftig", 50], ["zestig", 60], ["zeventig", 70], ["tachtig", 80], ["negentig", 90], ["honderd", 100], ["duizend", 1000], ["miljoen", 1_000_000], ["dozijn", 12], ["dubbel", "×2"], ["helft", "½"]],
  pt: [["dois", 2], ["duas", 2], ["três", 3], ["quatro", 4], ["cinco", 5], ["seis", 6], ["sete", 7], ["oito", 8], ["nove", 9], ["dez", 10], ["onze", 11], ["doze", 12], ["treze", 13], ["catorze", 14], ["quinze", 15], ["vinte", 20], ["trinta", 30], ["quarenta", 40], ["cinquenta", 50], ["sessenta", 60], ["setenta", 70], ["oitenta", 80], ["noventa", 90], ["cem", 100], ["mil", 1000], ["milhão", 1_000_000], ["milhões", "millions"], ["dúzia", 12], ["dobro", "×2"], ["metade", "½"]],
};

const ENGLISH_SCALES: Words = [["hundred", 100], ["thousand", 1000], ["million", 1_000_000], ["billion", 1_000_000_000]];
const alternation = (words: Words) => [...words].map(([word]) => word).sort((a, b) => b.length - a.length).join("|");
const BOUNDED = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");

/** English compounds first: "twenty-five", "two hundred", "a thousand", then single words. */
const ENGLISH_COMPOUND = `(?:${alternation(ENGLISH_TENS)})[- ](?:one|${alternation(ENGLISH_UNITS)})|(?:a|one|${alternation(ENGLISH)})\\s(?:${alternation(ENGLISH_SCALES)})`;
const WORD_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([code, words]) => [code, BOUNDED(code === "en" ? `${ENGLISH_COMPOUND}|${alternation([...words, ...ENGLISH_SCALES])}` : alternation(words))]),
);

const valueOf = (words: Words, word: string) => words.find(([one]) => one === word)?.[1];

/** What a number word stands for, so "twenty" and "20", or "double" and "twice", compare as one. */
function wordKey(written: string, code: string): string {
  const word = written.toLowerCase().replace(/\s+/g, " ");
  const words = code === "en" ? [...ENGLISH, ...ENGLISH_SCALES] : NUMBER_WORDS[code];
  const single = valueOf(words, word);
  if (single !== undefined) return String(single);
  if (code === "en") {
    const [first, second] = word.split(/[- ]/);
    const scale = valueOf(ENGLISH_SCALES, second);
    if (typeof scale === "number") {
      const times = first === "a" || first === "one" ? 1 : valueOf(ENGLISH, first);
      if (typeof times === "number") return String(times * scale);
    }
    const tens = valueOf(ENGLISH_TENS, first);
    const unit = second === "one" ? 1 : valueOf(ENGLISH_UNITS, second);
    if (typeof tens === "number" && typeof unit === "number") return String(tens + unit);
  }
  return word;
}

/** What digits stand for: "$1,200", "1200" and "1.2K" are one; "19,99" is 19.99; "$19", "19%" and "19" are one. */
function digitsKey(written: string): string {
  const bare = written.replace(/[$€£%\s]/g, "");
  const scale = /[kK]$/.test(bare) ? 1e3 : /[mM]$/.test(bare) ? 1e6 : /[bB]$/.test(bare) ? 1e9 : 1;
  const plain = bare
    .replace(/[kKmMbB]$/, "")
    .replace(/[.,](?=\d{3}(?!\d))/g, "")
    .replace(",", ".");
  const value = Number(plain) * scale;
  return Number.isFinite(value) ? String(value) : plain;
}

/** Each number in a text, as written and by what it stands for, in the order they appear. */
function numbersIn(text: string, codes: readonly string[]): { written: string; key: string; at: number }[] {
  const found: { written: string; key: string; at: number }[] = [];
  for (const match of text.matchAll(DIGITS)) {
    const written = match[0].replace(/[.,]+$/, "");
    found.push({ written, key: digitsKey(written), at: match.index ?? 0 });
  }
  for (const code of codes) {
    for (const match of text.matchAll(WORD_PATTERNS[code])) {
      const at = match.index ?? 0;
      // "Double-check it" asks for a check, it claims no number.
      if (/^double$/i.test(match[0]) && /^-check/i.test(text.slice(at + match[0].length))) continue;
      found.push({ written: match[0], key: wordKey(match[0], code), at });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** The languages whose number words are read: the draft's own, or English when it was not said. */
const wordLanguages = (language: string | null | undefined) => (language && NUMBER_WORDS[language] ? [language] : ["en"]);

/**
 * The numbers in the draft's text that are not in what the creator gave
 * (typed in the box, and the values the job was sent with: `givenTexts`),
 * each once, as written in the draft, in the order they appear. Whole numbers
 * only: "140" is never found in "40". Digits in any language; number words in
 * the draft's language (English when it was not said); what the creator gave
 * is read in that language and in English.
 */
export function unsourcedNumbers(texts: readonly string[], given: string | readonly string[], language?: string | null): string[] {
  const codes = wordLanguages(language);
  const givenCodes = [...new Set([...codes, "en"])];
  const known = new Set((typeof given === "string" ? [given] : given).flatMap((one) => numbersIn(one, givenCodes).map((number) => number.key)));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const { written, key } of numbersIn(text, codes)) {
      if (known.has(key) || seen.has(key)) continue;
      seen.add(key);
      found.push(written);
    }
  }
  return found;
}
