/**
 * 310 [AX2], section 3, point 1: the reading-level baseline of Marktmorgen's
 * own public English text (AX274 Part A, item 4, "Linguagem"; WCAG 2.2,
 * 3.1.5 Reading Level, AAA), measured by lib/reading-level.ts.
 *
 * Two parts:
 *   (a) the functions on fixed synthetic text whose counts are worked out by
 *       hand below: syllables against a fixed word list, the two formulas,
 *       the markup stripping and the sentence split;
 *   (b) the baseline: every page text read READ-ONLY from its own source
 *       module (topic, feature, creator and comparison pages; help; the home
 *       questions; buyer help; the legal pages and /accessibility, rendered),
 *       its Flesch-Kincaid grade over every fragment and over its prose alone
 *       (sentences of five words or more, so headings, labels and table cells
 *       do not pull the average down), and a table of the pages where either
 *       is above grade 9, hardest first.
 *
 * What fails here: a function off its worked numbers beyond the tolerance
 * written beside each check, or a source that cannot be read, renders no
 * page or a page with no words (unknown is never a pass). What does NOT
 * fail: a page above grade 9. This unit is the baseline; how the threshold
 * is held (per page, per sentence, a ratchet or a simplified version) waits
 * for the owner or the coordinator, so nothing is enforced yet.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import {
  LOWER_SECONDARY_GRADE,
  aboveLowerSecondary,
  fleschKincaidGrade,
  fleschReadingEase,
  plainText,
  readingLevel,
  sentencesOf,
  syllablesOf,
  wordsOf,
  type ReadingLevel,
} from "@/lib/reading-level";
import { PAGES } from "@/lib/site-pages";
import { HELP_SECTIONS } from "@/lib/help-content";
import { decisionQuestions, homeQuestions } from "@/lib/home-faq";
import { BUYER_HELP } from "@/lib/buyer-help";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import RefundsPage from "@/app/refunds/page";
import CopyrightPage from "@/app/copyright/page";
import AccessibilityPage from "@/app/accessibility/page";
import { done, is, part } from "./check";

/** Within a tolerance, printed as a plain pass or fail with both numbers. */
function near(what: string, got: number, want: number, tolerance: number): void {
  is(`${what} (${got.toFixed(3)} within ${tolerance} of ${want})`, Math.abs(got - want) <= tolerance, true);
}

function unitChecks(): void {
  part("The threshold is WCAG 3.1.5's lower secondary level: US grade 9");
  is("LOWER_SECONDARY_GRADE", LOWER_SECONDARY_GRADE, 9);
  const at = (grade: number): ReadingLevel => ({ sentences: 1, words: 1, syllables: 1, grade, ease: 0 });
  is("grade 9.0 is at the level, 9.1 above it", [aboveLowerSecondary(at(9)), aboveLowerSecondary(at(9.1))], [false, true]);

  part("Syllables: exact on a fixed word list (dictionary counts)");
  const exact: [string, number][] = [
    ["cat", 1], ["the", 1], ["make", 1], ["makes", 1], ["store", 1], ["free", 1], ["used", 1], ["signed", 1],
    ["page", 1], ["pages", 2], ["boxes", 2], ["teaches", 2], ["places", 2], ["wanted", 2], ["added", 2],
    ["simple", 2], ["table", 2], ["people", 2], ["money", 2], ["every", 3], ["email", 2], ["refund", 2],
    ["payment", 2], ["customer", 3], ["comprehensive", 4], ["documentation", 5], ["facilitates", 4],
    ["organizational", 6], ["understanding", 4], ["don't", 1], ["store's", 1], ["money-back", 3],
    ["AI", 2], ["PDF", 3], ["URL", 3], ["URLs", 3],
  ];
  // Two-syllable vowel pairs (hiatus), this product's own words, at their dictionary counts (Claude 7 on #4612): the
  // vowel groups alone read each pair as one, so every page read easier than it is.
  exact.push(
    ["creator", 3], ["creators", 3], ["create", 2], ["created", 3], ["creating", 3], ["studio", 3], ["video", 3],
    ["videos", 3], ["audio", 3], ["media", 3], ["period", 3], ["idea", 3], ["area", 3], ["being", 2], ["client", 2],
    ["previous", 3], ["various", 3], ["experience", 4], ["actual", 3], ["piano", 3],
    // And the pairs that stay one syllable, kept one.
    ["special", 2], ["nation", 2], ["region", 2], ["million", 2], ["people", 2], ["patient", 2], ["quality", 3],
    ["language", 2], ["friend", 1], ["social", 2], ["each", 1], ["great", 1], ["team", 1],
  );
  for (const [word, want] of exact) is(`syllablesOf(${JSON.stringify(word)})`, syllablesOf(word), want);

  part("Syllables: known misses of the heuristic, held to one syllable a word");
  // Dictionary counts; the heuristic misses "-ness", a silent "e" before "-be", a hiatus after s ("usual") and "quiet".
  const misses: [string, number][] = [["business", 2], ["maybe", 2], ["recipe", 3], ["usual", 3], ["quiet", 2], ["courteous", 3]];
  for (const [word, want] of misses) near(`syllablesOf(${JSON.stringify(word)}), dictionary ${want}`, syllablesOf(word), want, 1);

  part("The two formulas on round counts (worked by hand)");
  // 100 words, 5 sentences, 150 syllables: 0.39 × 20 + 11.8 × 1.5 − 15.59 = 9.91; 206.835 − 1.015 × 20 − 84.6 × 1.5 = 59.635.
  near("Flesch-Kincaid grade, 100 / 5 / 150", fleschKincaidGrade(100, 5, 150), 9.91, 1e-9);
  near("Flesch reading ease, 100 / 5 / 150", fleschReadingEase(100, 5, 150), 59.635, 1e-9);

  part("Whole texts with hand-counted words, sentences and syllables (tolerance 0.05 after rounding)");
  // 9 words, 2 sentences, 9 syllables: 0.39 × 4.5 + 11.8 − 15.59 = −2.035; ease 206.835 − 4.5675 − 84.6 = 117.6675.
  const easy = readingLevel("The cat sat on the mat. The dog ran.");
  is("easy: sentences, words, syllables", [easy.sentences, easy.words, easy.syllables], [2, 9, 9]);
  near("easy: grade", easy.grade, -2.035, 0.05);
  near("easy: ease", easy.ease, 117.6675, 0.05);
  // 5 words, 1 sentence, 4 + 5 + 4 + 6 + 4 = 23 syllables: 1.95 + 54.28 − 15.59 = 40.64; ease 206.835 − 5.075 − 389.16 = −187.4.
  const hard = readingLevel("Comprehensive documentation facilitates organizational understanding.");
  is("hard: sentences, words, syllables", [hard.sentences, hard.words, hard.syllables], [1, 5, 23]);
  near("hard: grade", hard.grade, 40.64, 0.05);
  near("hard: ease", hard.ease, -187.4, 0.05);
  is("the hard sentence is above grade 9, the easy one is not", [aboveLowerSecondary(hard), aboveLowerSecondary(easy)], [true, false]);
  // 13 words, 2 sentences, 13 syllables: 0.39 × 6.5 + 11.8 − 15.59 = −1.255; ease 206.835 − 6.5975 − 84.6 = 115.6375.
  const steps = readingLevel(["You sign up and pick a name.", "Then you add what you sell"]);
  is("fragments: each one ends a sentence", [steps.sentences, steps.words, steps.syllables], [2, 13, 13]);
  near("fragments: grade", steps.grade, -1.255, 0.05);

  // With minSentenceWords 5 the two-word heading and the one-word label leave the count: 8 words, 1 sentence, 8 syllables.
  const prose = readingLevel(["Our plans", "Yes", "You can change your plan at any time."], { minSentenceWords: 5 });
  is("minSentenceWords leaves out headings and labels", [prose.sentences, prose.words, prose.syllables], [1, 8, 8]);
  is("without it they count", readingLevel(["Our plans", "Yes", "You can change your plan at any time."]).sentences, 3);

  part("Markup, links, code and numbers are stripped before counting");
  const html = "<p>Read <a href=\"https://example.test/guide\">the guide</a> at https://marktmorgen.com/help for $4,490.</p><code>npm install</code><p>Write to help@example.test or 60% off.</p>";
  is("plainText of a marked-up fragment", plainText(html), "Read the guide at for .\nWrite to or off.");
  is("its words", wordsOf(plainText(html)), ["Read", "the", "guide", "at", "for", "Write", "to", "or", "off"]);
  is("block ends and <br> end a sentence", sentencesOf(plainText("<h2>Plans</h2><li>One store</li>Line one<br>Line two")), ["Plans", "One store", "Line one", "Line two"]);
  is("an abbreviation does not end a sentence", sentencesOf("Use a card, e.g. Visa. Then pay."), ["Use a card, e.g. Visa.", "Then pay."]);
  is("a store address is not a word", wordsOf(plainText("Open marktmorgen.com/@store-name/orders now")), ["Open", "now"]);
  let threw = "";
  try {
    readingLevel("<p>$69</p>");
  } catch (error) {
    threw = (error as Error).message;
  }
  is("text with no word throws: unknown is never a pass", threw, "reading level: no readable words in this text");
}

/** Keys that hold no words a reader sees on the page: identifiers, styles, links, search metadata and menus. */
const NOT_PAGE_TEXT = new Set(["slug", "section", "kind", "emoji", "tint", "tone", "href", "icon", "accent", "visual", "plan", "group", "related", "id", "photo", "routes", "seo", "menu"]);

/** Every visible string of a content record, in order, each as its own fragment. */
function fragmentsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) fragmentsOf(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (!NOT_PAGE_TEXT.has(key)) fragmentsOf(item, out);
  }
  return out;
}

/** Prose only: sentences of at least this many words, so headings, labels and table cells do not lower the grade. */
const PROSE_WORDS = 5;

/** `level` reads every fragment; `prose` only sentences of PROSE_WORDS words or more (null when a page has none). */
type Measured = { source: string; page: string; level: ReadingLevel; prose: ReadingLevel | null };

/** A page counts as above the level when either reading is: the higher grade is the one reported. */
function hardest(m: Measured): number {
  return Math.max(m.level.grade, m.prose?.grade ?? -Infinity);
}

function measure(source: string, pages: () => { page: string; text: string[] }[], into: Measured[]): void {
  let read: { page: string; text: string[] }[] = [];
  let error = "";
  try {
    read = pages();
  } catch (caught) {
    error = (caught as Error).message;
  }
  is(`${source}: the source reads`, error, "");
  is(`${source}: it has at least one page`, read.length > 0, true);
  let unreadable: string[] = [];
  for (const { page, text } of read) {
    try {
      const level = readingLevel(text);
      let prose: ReadingLevel | null = null;
      try {
        prose = readingLevel(text, { minSentenceWords: PROSE_WORDS });
      } catch {
        prose = null; // only short fragments: the all-text reading stands alone
      }
      into.push({ source, page, level, prose });
    } catch {
      unreadable = [...unreadable, page];
    }
  }
  is(`${source}: every page has readable words (${read.length} pages)`, unreadable, []);
}

/** The text inside the page's <main>: the shared menu and footer are measured once, not once per page. */
function renderedMain(Page: ComponentType): string[] {
  const html = renderToStaticMarkup(createElement(Page));
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/);
  if (!main) throw new Error("no <main> in the rendered page");
  return [main[1]];
}

function baseline(): void {
  part("Baseline: every source of Marktmorgen's own public text reads");
  const measured: Measured[] = [];
  measure("topic, feature, creator and comparison pages (lib/site-pages.ts)", () =>
    PAGES.map((p) => ({ page: `/${p.section}/${p.slug}`, text: fragmentsOf({ eyebrow: p.eyebrow, heading: `${p.title} ${p.highlight}`, intro: p.intro, badge: p.badge.label, blocks: p.blocks }) })), measured);
  measure("help center (lib/help-content.ts)", () =>
    HELP_SECTIONS.map((s) => ({ page: `/help#${s.id}`, text: fragmentsOf({ title: s.title, blurb: s.blurb, items: s.items }) })), measured);
  measure("home questions (lib/home-faq.ts)", () => [
    { page: "/ (questions before deciding)", text: fragmentsOf(decisionQuestions()) },
    { page: "/ (home questions)", text: fragmentsOf(homeQuestions()) },
  ], measured);
  measure("buyer help (lib/buyer-help.ts)", () =>
    BUYER_HELP.map((item) => ({ page: `buyer help: ${item.id}`, text: fragmentsOf({ q: item.q, a: item.a }) })), measured);
  measure("legal pages and /accessibility (rendered <main>)", () => [
    { page: "/privacy", text: renderedMain(PrivacyPage) },
    { page: "/terms", text: renderedMain(TermsPage) },
    { page: "/refunds", text: renderedMain(RefundsPage) },
    { page: "/copyright", text: renderedMain(CopyrightPage) },
    { page: "/accessibility", text: renderedMain(AccessibilityPage) },
  ], measured);

  const pages = new Set(measured.map((m) => `${m.source} ${m.page}`));
  is("no page is measured twice", pages.size, measured.length);

  const above = measured.filter((m) => hardest(m) > LOWER_SECONDARY_GRADE).sort((a, b) => hardest(b) - hardest(a) || a.page.localeCompare(b.page));
  const grades = measured.map(hardest).sort((a, b) => a - b);
  const median = grades.length % 2 ? grades[(grades.length - 1) / 2] : (grades[grades.length / 2 - 1] + grades[grades.length / 2]) / 2;
  const words = measured.reduce((sum, m) => sum + m.level.words, 0);

  console.log(`\nBaseline (not enforced): ${measured.length} pages, ${words} words; median grade ${median.toFixed(1)} (the higher of all text and prose); ${above.length} above grade ${LOWER_SECONDARY_GRADE}.`);
  const bySource = new Map<string, [number, number]>();
  for (const m of measured) {
    const [all, over] = bySource.get(m.source) ?? [0, 0];
    bySource.set(m.source, [all + 1, over + (hardest(m) > LOWER_SECONDARY_GRADE ? 1 : 0)]);
  }
  for (const [source, [all, over]] of bySource) console.log(`  ${String(over).padStart(4)} of ${String(all).padEnd(4)} ${source}`);
  console.log(`\nPages above grade ${LOWER_SECONDARY_GRADE}, hardest first ("all": every fragment; "prose": sentences of ${PROSE_WORDS}+ words):`);
  console.log("    all  prose   ease  words  sentences  page");
  for (const m of above) {
    const { grade, words: w, sentences } = m.level;
    const prose = m.prose ? m.prose.grade.toFixed(1) : "-";
    const ease = (m.prose ?? m.level).ease.toFixed(1);
    console.log(`  ${grade.toFixed(1).padStart(5)} ${prose.padStart(6)} ${ease.padStart(6)} ${String(w).padStart(6)} ${String(sentences).padStart(10)}  ${m.page}`);
  }
}

unitChecks();
baseline();
done();
