/**
 * Every number written as words is a period of time before a unit (Codex
 * D2's MEDIUM on #2177: "thirteen days" and "seventeen days" were missing
 * from a list, so a cut page's promise passed without its condition). The
 * numbers here are spelled by small generators written apart from the code,
 * in the seven store languages, from two to ninety-nine, plus hundreds; each
 * one before a unit of time speaks of terms. The articles alone ("a week of
 * dinners") and a unit without a number ("weekly") still do not, and a long
 * text of number words is read quickly.
 */
import { speaksOfTerms } from "@/lib/store-assistant-rules";
import { done, is } from "./check";

const EN_UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const english = (n: number) => (n < 20 ? EN_UNITS[n] : EN_TENS[Math.floor(n / 10)] + (n % 10 ? "-" + EN_UNITS[n % 10] : ""));

const ES_LOW = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiún", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const ES_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const spanish = (n: number) => (n < 30 ? ES_LOW[n] : ES_TENS[Math.floor(n / 10)] + (n % 10 === 1 ? " y un" : n % 10 ? " y " + ES_LOW[n % 10] : ""));

const FR_LOW = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const FR_TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];
function french(n: number): string {
  if (n < 20) return FR_LOW[n];
  if (n < 70) return FR_TENS[Math.floor(n / 10)] + (n % 10 === 1 ? " et un" : n % 10 ? "-" + FR_LOW[n % 10] : "");
  if (n < 80) return "soixante" + (n === 71 ? " et onze" : "-" + FR_LOW[n - 60]);
  if (n === 80) return "quatre-vingts";
  return "quatre-vingt-" + FR_LOW[n - 80];
}

const DE_LOW = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const DE_TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
const german = (n: number) => (n < 20 ? DE_LOW[n] : (n % 10 ? (n % 10 === 1 ? "ein" : DE_LOW[n % 10]) + "und" : "") + DE_TENS[Math.floor(n / 10)]);

const IT_LOW = ["", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
const IT_TENS = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
function italian(n: number): string {
  if (n < 20) return IT_LOW[n];
  const tens = IT_TENS[Math.floor(n / 10)];
  const unit = n % 10;
  if (!unit) return tens;
  return (unit === 1 || unit === 8 ? tens.slice(0, -1) : tens) + (unit === 3 ? "tré" : IT_LOW[unit]);
}

const NL_LOW = ["", "een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien", "elf", "twaalf", "dertien", "veertien", "vijftien", "zestien", "zeventien", "achttien", "negentien"];
const NL_TENS = ["", "", "twintig", "dertig", "veertig", "vijftig", "zestig", "zeventig", "tachtig", "negentig"];
const dutch = (n: number) => (n < 20 ? NL_LOW[n] : (n % 10 ? NL_LOW[n % 10] + (NL_LOW[n % 10].endsWith("e") ? "ën" : "en") : "") + NL_TENS[Math.floor(n / 10)]);

const PT_LOW = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const PT_TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const portuguese = (n: number) => (n < 20 ? PT_LOW[n] : PT_TENS[Math.floor(n / 10)] + (n % 10 ? " e " + PT_LOW[n % 10] : ""));

const LANGUAGES: [string, (n: number) => string, string][] = [
  ["English", english, "days"],
  ["Spanish", spanish, "días"],
  ["French", french, "jours"],
  ["German", german, "Tage"],
  ["Italian", italian, "giorni"],
  ["Dutch", dutch, "dagen"],
  ["Portuguese", portuguese, "dias"],
];

for (const [language, spell, unit] of LANGUAGES) {
  const missed: string[] = [];
  for (let n = 2; n <= 99; n++) {
    const words = spell(n);
    for (const sentence of [`You can try it for ${words} ${unit}.`, `${words[0].toUpperCase()}${words.slice(1)} ${unit} to decide.`]) {
      if (!speaksOfTerms(sentence)) missed.push(sentence);
    }
  }
  is(`${language}: every number from two to ninety-nine in words, before a unit of time, speaks of terms`, missed, []);
}

const HUNDREDS = [
  "three hundred sixty-five days", "a hundred days", "trescientos sesenta y cinco días", "cien días", "doscientos días",
  "trois cent soixante-cinq jours", "cent jours", "dreihundertfünfundsechzig Tage", "hundert Tage", "trecentosessantacinque giorni",
  "cento giorni", "driehonderdvijfenzestig dagen", "honderd dagen", "trezentos e sessenta e cinco dias", "cem dias", "quinhentos dias",
  "thirteen-day trial", "seventeen-day window", "dreizehntägige Frist", "dertiendaagse proef", "Thirteen days", "thirteen\ndays",
];
is("hundreds, compound adjectives and other spacing speak of terms", HUNDREDS.filter((text) => !speaksOfTerms(text)), []);

const NOT_TERMS = [
  "It is a weekly meal planner.", "A week of dinners, planned.", "Una semana de cenas.", "Une semaine de dîners.", "Eine Woche Abendessen.",
  "Una settimana di cene.", "Een week avondeten.", "Uma semana de jantares.", "Ten recipes in one file.", "Once you buy, you get the file.",
  "Seven chapters and a workbook.", "Sette capitoli.", "Zeven hoofdstukken.",
];
is("an article alone, a unit without a number and numbers without a unit do not", NOT_TERMS.filter((text) => speaksOfTerms(text)), []);

const pieces = ["tre", "trenta", "vent", "venti", "dieci", "sei", "seis", "dos", "cientos", "drei", "und", "zwanzig", "e", "y", "en", "een", "um", "twenty", "one"];
let long = "";
let seed = 7;
while (long.length < 20000) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  long += pieces[seed % pieces.length] + (seed % 3 === 0 ? " " : seed % 3 === 1 ? "-" : "");
}
// Revisor 1's runs (06h00): "vingt et un " and "twenty-" repeated took about 2.0 s and 0.7 s before the number was bounded.
for (const text of [long + "x", "tre".repeat(7000) + "!", ("venti e tre " + "e ").repeat(1500) + "zz", ("einund" + "zwanzig").repeat(1500), "vingt et un ".repeat(2000), "twenty-".repeat(3000), "twenty one ".repeat(2200)]) {
  const started = performance.now();
  speaksOfTerms(text);
  const took = performance.now() - started;
  is(`a long text of number words (${text.length} signs) is read in a quarter of a second`, took < 250, true);
}

done();
