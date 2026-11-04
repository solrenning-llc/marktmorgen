/**
 * A product's page, built from blocks: a sales page for something paid, or a
 * landing page that asks for an email address for something free.
 *
 * Every product already had a page of its own, with the long description
 * under its picture (lib/product-about.ts). This is the same page, laid out
 * by the creator: a hero, paragraphs, a list of what the buyer gets, what is
 * inside, who made it, questions and answers, a note on refunds, buttons
 * that lead to the checkout, and the buyers' own reviews (lib/reviews.ts).
 * A product without blocks keeps the page it has always had.
 *
 * Three rules make it something a buyer can trust, and they are kept here so
 * the studio's preview and the page itself apply the same ones:
 *
 *   - Nothing a creator types is ever read as markup. Every block is plain
 *     text with a fixed shape; paragraphs, "- " lists and written-out https
 *     addresses are the only formatting there is, drawn by the page itself
 *     (the same reading as the long description). A script, a style or a
 *     hidden element cannot be put on a page from here.
 *   - A video is one of three players, recognised from its address and
 *     rebuilt from its id — YouTube (on its privacy-enhanced address, which
 *     sets no cookie until the video plays), Vimeo (with do-not-track) and
 *     Loom. No other address becomes a frame, and the page loads none of
 *     them until the visitor presses play.
 *   - The terms are never the blocks'. A button in a block only leads to the
 *     checkout the page already has, with the price, options and plan the
 *     store page shows; a block cannot state a price of its own.
 *
 * The blocks live in a record of their own (lib/sales-page-store.ts), not in
 * the store's, which every visitor to the store page reads whole. Pure, so
 * the studio can import it.
 */

import { type LanguageCode, isLanguage } from "@/lib/store-language";

/** The most blocks one page may have. */
export const MAX_BLOCKS = 30;
/** The most questions one block of questions may have. */
export const MAX_FAQ_ITEMS = 15;
export const MAX_BENEFITS = 12;
export const MAX_INSIDE_ITEMS = 20;

export const MAX_HEADLINE = 120;
export const MAX_SUBHEADLINE = 300;
export const MAX_HEADING = 100;
export const MAX_TEXT = 3_000;
export const MAX_ITEM = 200;
export const MAX_ITEM_DETAIL = 300;
export const MAX_BIO = 1_200;
export const MAX_QUESTION = 200;
export const MAX_ANSWER = 1_500;
export const MAX_GUARANTEE = 1_000;
export const MAX_CTA_LABEL = 40;
export const MAX_CTA_NOTE = 120;
export const MAX_SEO_TITLE = 70;
/** The line under a video block's player. */
export const MAX_CAPTION = 300;
/** Pictures in one block, and on one page: each is at most a megabyte (lib/product-image.ts). */
export const MAX_PICTURES = 6;
export const MAX_PAGE_PICTURES = 24;
export const MAX_PICTURE_CAPTION = 140;
/** What a countdown says it counts down to, and what it says under the numbers. */
export const MAX_COUNTDOWN_LABEL = 80;
export const MAX_COUNTDOWN_NOTE = 200;
/** No countdown to a moment further away than this: a year is a plan, not a deadline. */
export const MAX_COUNTDOWN_DAYS = 366;
export const MAX_SEO_DESCRIPTION = 160;
/** Points on each side of a "who it is for" block. */
export const MAX_FIT_ITEMS = 8;
/** Steps in a "how it works" block, bonuses in a bonus block. */
export const MAX_STEPS = 8;
export const MAX_BONUSES = 8;
/** Rows in a comparison, and the length of a column's name and of one cell. */
export const MAX_COMPARE_ROWS = 12;
export const MAX_COLUMN = 40;
export const MAX_CELL = 80;
/** What a cell holds to be drawn as a tick or a cross rather than as words. */
export const CELL_YES = "\u2713";
export const CELL_NO = "\u2717";
/** The most a page's record may weigh, in bytes: well past thirty full blocks. A second version tested against it may weigh as much again. */
export const MAX_PAGE_BYTES = 120_000;
/** The most a stored record is read at: the page and a second version, with room to spare. */
export const MAX_STORED_PAGE_BYTES = MAX_PAGE_BYTES * 3;
/** Things said about it elsewhere, in one block; the words of one, the name beside it, and its link. */
export const MAX_QUOTES = 6;
export const MAX_QUOTE = 400;
export const MAX_QUOTE_NAME = 60;
export const MAX_QUOTE_URL = 300;

export type BlockKind =
  | "hero"
  | "text"
  | "benefits"
  | "inside"
  | "bio"
  | "faq"
  | "guarantee"
  | "cta"
  | "reviews"
  | "video"
  | "pictures"
  | "countdown"
  | "fit"
  | "steps"
  | "compare"
  | "bonuses"
  | "facts"
  | "feature"
  | "product"
  | "quotes"
  | "form"
  | "row"
  | "booking";

export const BLOCK_KINDS: { kind: BlockKind; label: string; hint: string }[] = [
  { kind: "hero", label: "Hero", hint: "The big headline at the top, with the product's picture or a video." },
  { kind: "text", label: "Text", hint: "A heading and paragraphs. A line starting with “- ” is a point in a list." },
  { kind: "benefits", label: "Benefits", hint: `Up to ${MAX_BENEFITS} short points, each with a check mark.` },
  { kind: "inside", label: "What's inside", hint: `Up to ${MAX_INSIDE_ITEMS} parts, numbered, each with a line about it.` },
  { kind: "bio", label: "About you", hint: "Who made this, with your store photo." },
  { kind: "faq", label: "Questions", hint: `Up to ${MAX_FAQ_ITEMS} questions and answers that open and close.` },
  { kind: "guarantee", label: "Guarantee", hint: "Your refund promise, in your own words." },
  { kind: "cta", label: "Button", hint: "A button that goes to the checkout (or the sign-up form)." },
  { kind: "reviews", label: "Reviews", hint: "Where buyers' verified reviews sit on the page." },
  { kind: "video", label: "Video", hint: "A video anywhere on the page — a lesson to try, a walkthrough, a result — with a heading and a line under it." },
  { kind: "pictures", label: "Pictures", hint: `Up to ${MAX_PICTURES} pictures of your own — pages of the book, a screen of the course, the finished result — each with a line under it.` },
  { kind: "countdown", label: "Countdown", hint: "Days, hours and minutes to one real moment, the same for every visitor: a launch price ending, doors closing, a live session starting." },
  { kind: "fit", label: "Who it is for", hint: `Two short lists side by side: who it is for, and who it is not for. Up to ${MAX_FIT_ITEMS} points each.` },
  { kind: "steps", label: "How it works", hint: `Up to ${MAX_STEPS} numbered steps, from paying to the result, drawn as a path.` },
  { kind: "compare", label: "Comparison", hint: `A table of up to ${MAX_COMPARE_ROWS} rows: this product beside another way of getting there, with check marks, crosses or a few words.` },
  { kind: "bonuses", label: "Bonuses", hint: `Up to ${MAX_BONUSES} extras that come with it, each on its own card.` },
  { kind: "feature", label: "Picture and text", hint: "One of your pictures beside a heading and a few paragraphs, the picture on the left or the right. Several in a row make the page read like a story." },
  { kind: "quotes", label: "Said elsewhere", hint: `Up to ${MAX_QUOTES} things people said about it in public — a post, a video, a comment — each with a link to where it was said, so a visitor can check it.` },
  { kind: "product", label: "Another product", hint: "One of your other products, with its picture, price and a link to its own page: what goes well with this one." },
  { kind: "facts", label: "By the numbers", hint: "Lessons, episodes, buyers, the average rating: counted for you from the store, never typed, and always up to date." },
  { kind: "form", label: "Form", hint: "One of your forms, surveys or quizzes, made under Forms: the questions, and where the answers lead. On your own pages." },
  // On a product's page only: not in SITE_KINDS (lib/site-page-rules.ts) nor in a saved section (lib/saved-blocks.ts, NOT_IN_SECTIONS).
  { kind: "row", label: "Columns", hint: "One to three columns side by side, each with headings, words, a list, icons, buttons, pictures or a video. One column on a phone." },
];

export type VideoProvider = "youtube" | "vimeo" | "loom";

/** A video, kept as its player and id only, never as the address typed. */
export type Video = { provider: VideoProvider; id: string; hash: string };

export type HeroBlock = {
  id: string;
  kind: "hero";
  headline: string;
  sub: string;
  /** What sits beside the words: the product's picture, a video, or nothing. */
  media: "picture" | "video" | "none";
  video: Video | null;
  /**
   * How the words and the picture sit (added 8 October 2026): side by side
   * (left unsaid), centred with the picture under them, or the picture
   * behind the words, darkened so they read on any picture. A video is
   * never behind the words: there it is centred.
   */
  layout?: HeroLayout;
  /** A button under the words, leading where every button on the page leads. */
  button?: boolean;
};
export type HeroLayout = "split" | "centered" | "cover";
export const HERO_LAYOUTS: { value: HeroLayout; label: string }[] = [
  { value: "split", label: "Side by side" },
  { value: "centered", label: "Centered" },
  { value: "cover", label: "Picture behind the words" },
];
export type TextBlock = { id: string; kind: "text"; heading: string; body: string };
export type BenefitsBlock = { id: string; kind: "benefits"; heading: string; items: string[] };
export type InsideItem = { title: string; detail: string };
export type InsideBlock = { id: string; kind: "inside"; heading: string; items: InsideItem[] };
export type BioBlock = { id: string; kind: "bio"; heading: string; body: string; photo: boolean };
export type FaqItem = { q: string; a: string };
export type FaqBlock = { id: string; kind: "faq"; heading: string; items: FaqItem[] };
export type GuaranteeBlock = { id: string; kind: "guarantee"; heading: string; body: string };
export type CtaBlock = { id: string; kind: "cta"; label: string; note: string };
/**
 * Where the verified reviews stand. `first` is up to three of them the
 * creator picked to show before the others, by id; each is still a review a
 * buyer who paid wrote, shown with its own stars and marked as picked, and
 * the average and the count stay those of every review.
 */
export type ReviewsBlock = { id: string; kind: "reviews"; heading: string; first: string[] };
export const MAX_PICKED_REVIEWS = 3;
// The same as lib/review-summary.ts. Written here, not imported: next.config.ts
// reads this file (through lib/csp.ts), and the config loader cannot follow
// an import. tests/picked-reviews.test.ts holds the two to the same rule.
const REVIEW_ID_PATTERN = /^[0-9a-f]{24}$/;
/**
 * A video of its own, anywhere below the hero (added 7 October 2026). The
 * hero carries one video; a sales page that sells a course or a skill often
 * wants more — a sample lesson, a walkthrough, the thing being made — and a
 * page may now have as many as it has blocks. Each is the same lazy player
 * the hero uses: nothing loads from YouTube, Vimeo or Loom until play.
 */
export type VideoBlock = { id: string; kind: "video"; heading: string; video: Video | null; caption: string };

/**
 * One picture on a page: a file in the store's own picture folder
 * (lib/product-image.ts), the words that describe it and a line under it.
 */
export type Picture = { path: string; width: number; height: number; alt: string; caption: string };

/**
 * Pictures of the creator's own, anywhere below the hero (added 7 October
 * 2026). Measured that day: Kajabi and Hotmart Pages have an image and a
 * gallery section, and a page that sells a book or a course without one
 * picture of what is inside is selling blind. Each picture is shrunk in the
 * creator's browser and served from our own address like a product's
 * picture, so nothing loads from anywhere else and nothing can carry a script.
 */
export type PicturesBlock = { id: string; kind: "pictures"; heading: string; items: Picture[] };

/**
 * A countdown to one moment (added 7 October 2026). Kajabi, Hotmart Pages,
 * ClickFunnels and Systeme.io all have one; theirs can also be "evergreen",
 * restarting for every visitor so that the deadline is never real. This one
 * cannot: `until` is one moment in time, the same for everybody, and once it
 * has passed the block is not drawn at all. What changes at that moment is
 * the creator's to say, in their own words, like the guarantee.
 */
export type CountdownBlock = { id: string; kind: "countdown"; heading: string; until: number; note: string };

/**
 * Who it is for, and who it is not for (added 8 October 2026). Saying who
 * should not buy is the most honest line a sales page can carry, and the
 * one that sends the fewest refunds back: a buyer who reads themselves in
 * the second list leaves before paying instead of after. The two headings
 * are the creator's to change; left empty, the page writes them in the
 * store's language.
 */
export type FitBlock = { id: string; kind: "fit"; heading: string; yesLabel: string; noLabel: string; yes: string[]; no: string[] };

/** How it works: numbered steps, drawn as a path (added 8 October 2026). */
export type StepsBlock = { id: string; kind: "steps"; heading: string; items: InsideItem[] };

/**
 * A comparison (added 8 October 2026): this product beside one other way of
 * getting the same thing — doing it alone, a free video, the usual course.
 * Every cell is the creator's own words; a tick or a cross is a cell that
 * holds only CELL_YES or CELL_NO, drawn as an icon with its meaning spoken
 * to a screen reader. The other column names no competitor by default, and
 * nothing here states a price: the price is the buy box's.
 */
export type CompareRow = { label: string; a: string; b: string };
export type CompareBlock = { id: string; kind: "compare"; heading: string; columnA: string; columnB: string; rows: CompareRow[] };

/**
 * What comes with it besides (added 8 October 2026). Each bonus is a title and
 * a line, numbered on its card. No "worth $497" next to it: a value nobody
 * ever paid is a number made up to make the price look small, and a buyer
 * who notices stops believing the rest of the page.
 */
export type BonusesBlock = { id: string; kind: "bonuses"; heading: string; items: InsideItem[] };

/**
 * The numbers that are true about it, counted by the store itself (added 8
 * October 2026): a course's lessons, a podcast's episodes, a bundle's
 * products, a call's length, how many times it was bought (only when the
 * store shows that, and from ten up) and its buyers' average rating. The
 * creator only chooses which may appear; a number that is not there yet is
 * simply not drawn, so the block can never say something false.
 */
export type FactKey = "lessons" | "episodes" | "products" | "length" | "buyers" | "rating";
export const FACT_KEYS: { key: FactKey; label: string; hint: string }[] = [
  { key: "lessons", label: "Lessons", hint: "How many lessons the course has." },
  { key: "episodes", label: "Episodes", hint: "How many episodes the private podcast has." },
  { key: "products", label: "Products inside", hint: "How many products the bundle holds." },
  { key: "length", label: "Call length", hint: "How long each call lasts." },
  { key: "buyers", label: "Times bought", hint: "Shown from 10 sales up, and only while your store's look shows how many times products were bought." },
  { key: "rating", label: "Average rating", hint: "From verified buyers' reviews, with how many there are." },
];
export type FactsBlock = { id: string; kind: "facts"; heading: string; show: FactKey[] };

/**
 * Another of the store's products, shown as a card with its picture, its
 * price as the store shows it and a link to its own page (added 8 October
 * 2026): the course beside the ebook, the next step after the free guide.
 * Only the product's id is kept, so its name, picture and price are always
 * today's; a product taken off, or one past the store's first page of
 * products, is simply not drawn.
 */
export type ProductBlock = { id: string; kind: "product"; heading: string; product: string; note: string };
export const MAX_PRODUCT_NOTE = 160;

/**
 * A picture beside words (added 8 October 2026): the section Kajabi's and
 * Hotmart Pages' templates are mostly made of — a screen of the course and
 * what it teaches, a page of the book and why it is there. The picture is one
 * of the creator's own, kept like a pictures block's, and counted with them
 * toward the page's pictures.
 */
/**
 * Things people said about it in public, elsewhere (added 9 October 2026):
 * a post on X, a comment under a video, a newsletter that mentioned it.
 * Kajabi, Hotmart Pages and Stan let a creator type any testimonial at all,
 * with nothing to show it was ever said. Here each one carries the address
 * where it was said, shown under it as a link a visitor can follow and
 * check; one without a working https address is not kept. It is never shown
 * as a review: reviews are only buyers' (ReviewsBlock), with their stars,
 * and nothing here counts toward the average.
 */
export type Quote = { text: string; name: string; url: string };
export type QuotesBlock = { id: string; kind: "quotes"; heading: string; items: Quote[] };

/** One of the store's forms, surveys or quizzes (lib/forms.ts), by its id: only on the store's own pages. */
export type FormBlock = { id: string; kind: "form"; heading: string; form: string };

/**
 * One of the store's calls, booked from the page itself (552 [BB1], added
 * 4 November 2026): a paid call, a call also sold in packages, or a free
 * intro call (551 [FB1]), by its product id. Only the id and an optional
 * heading are kept, so the call's name, length and place are always today's,
 * read from the call itself; a call taken off, made a draft or no longer a
 * call is simply not drawn. Unit 1 draws a link to the call's own booking
 * page (/@<store>/book/<id>); the time picker inside the block comes with
 * unit 2, from the same picker and the same times, never a second way of
 * booking.
 *
 * One per page (MAX_BOOKING_BLOCKS), as the reviews have one place: two would
 * ask a visitor the same question twice, and once the picker is in the block
 * each one reads the call's times, so a second one would double the reads for
 * nothing.
 */
export type BookingBlock = { id: string; kind: "booking"; product: string; heading: string };
export const MAX_BOOKING_BLOCKS = 1;

/** An https address as it will be linked, or "" when it is not one: no other scheme, no login in it, no address on this machine. */
export function quoteUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (!text || text.length > MAX_QUOTE_URL) return "";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) return "";
  return url.href.length > MAX_QUOTE_URL ? "" : url.href;
}

/** Where a quote was said, as a visitor reads it: "x.com", "youtube.com". */
export function quoteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(www|m|mobile)\./, "");
  } catch {
    return "";
  }
}

export type FeatureBlock = { id: string; kind: "feature"; heading: string; body: string; picture: Picture | null; side: "left" | "right" };

/**
 * A row of one, two or three columns, each a short list of small elements
 * (added 4 November 2026, queue item 375 [TB1], unit 1): the rows ClickFunnels'
 * editor is built from, held to the same rules as every other block. Each
 * element is plain text with a fixed shape, one of the creator's own
 * pictures, or a video from one of the three players; a button leads to the
 * page's own checkout, or to an https address checked like a quote's
 * (quoteUrl). On a phone the columns become one, in reading order: the first
 * column's elements, then the second's, then the third's.
 *
 * A video can also sit behind a button of its own words and open in a
 * window over the page (unit 5): the same three players, loaded only once the
 * button is pressed, in a dialog built the way the picture viewer's is
 * (components/video-window.tsx after components/picture-viewer.tsx).
 *
 * Left out, and why: audio (no block keeps an audio file of its own; a file
 * would need the claim and delete rules pictures have in
 * lib/sales-page-store.ts).
 */
export const MIN_ROW_COLUMNS = 1;
export const MAX_ROW_COLUMNS = 3;
/** Elements in one column, and in a whole row: a full row weighs no more than a full questions block. */
export const MAX_COLUMN_ELEMENTS = 8;
export const MAX_ROW_ELEMENTS = 12;
export const MAX_ROW_PARAGRAPH = 1_500;
export const MAX_ROW_LIST_ITEMS = 8;
export const MAX_ICON_LABEL = 80;

/**
 * The icons a row may show, by name: each one of the site's own drawings
 * (components/icons.tsx), so nothing is loaded from elsewhere. Written here,
 * not imported, for the reason REVIEW_ID_PATTERN is; the type check in
 * components/sales-blocks.tsx holds every name to a drawing that exists.
 */
export const ROW_ICONS = [
  "check",
  "check-circle",
  "star",
  "shield",
  "gift",
  "clock",
  "calendar",
  "book",
  "chat",
  "target",
  "bolt",
  "sparkle",
  "lock",
  "globe",
  "user",
  "users",
  "mail",
  "phone",
  "play",
  "video",
  "camera",
  "music",
  "mic",
  "cap",
  "chart",
  "key",
  "pin",
  "download",
  "info",
] as const;
export type RowIcon = (typeof ROW_ICONS)[number];

/**
 * One small element of a row's column. An icon with no label is decoration,
 * hidden from screen readers; with one, the label is what it says. A picture
 * needs the words that describe it unless it is marked decorative. A button
 * with an address needs words of its own: the page's default label names
 * the checkout. An empty address is the page's own checkout.
 */
export type RowElement =
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "icon"; name: RowIcon; label: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "image"; picture: Picture; decorative: boolean }
  | { kind: "video"; video: Video; title: string }
  /**
   * A video behind a button (unit 5): the button's own words open a window
   * with the player. A kind of its own, not a flag on "video", so every
   * switch over the parts has to say how it draws, reads and copies one,
   * and a part made before it can never be read as one.
   */
  | { kind: "video-window"; video: Video; title: string; label: string };
export type RowElementKind = RowElement["kind"];
export const ROW_ELEMENT_KINDS: readonly RowElementKind[] = ["heading", "subheading", "paragraph", "list", "icon", "button", "image", "video", "video-window"];

export type RowBlock = { id: string; kind: "row"; columns: RowElement[][] };

/**
 * Where a block shows (added 8 October 2026): on every screen, which is
 * left unsaid, or only on phones, or only on computers and tablets — a
 * shorter list for a phone, a wide table only where it fits. The line
 * between the two is the page's own width, 700 pixels, the same width at
 * which the hero puts its picture beside the headline. The hero always
 * shows: it carries the page's one main heading.
 */
export type BlockShow = "phone" | "computer";
export const BLOCK_SHOWS: { value: BlockShow | "all"; label: string }[] = [
  { value: "all", label: "Every screen" },
  { value: "phone", label: "Phones only" },
  { value: "computer", label: "Computers and tablets only" },
];

/**
 * A saved section's id (lib/saved-blocks.ts) on each block that came from it,
 * so a later change to the section can be offered to every page using it.
 */
export const SAVED_BLOCK_ID = /^[a-z0-9]{10}$/;

/**
 * `lang`, on a block: the language its words are in, when it is not the
 * page's own (a block a translation had to leave as it was, lib/page-translate.ts,
 * keepEveryBlock). The page draws it with that lang so a screen reader reads
 * it in its own language (WCAG 3.1.2). Never guessed: absent when unknown.
 */
export type PageBlock = { screens?: BlockShow; saved?: string; lang?: LanguageCode } & (
  | FeatureBlock
  | FitBlock
  | StepsBlock
  | CompareBlock
  | BonusesBlock
  | FactsBlock
  | HeroBlock
  | TextBlock
  | BenefitsBlock
  | InsideBlock
  | BioBlock
  | FaqBlock
  | GuaranteeBlock
  | CtaBlock
  | ReviewsBlock
  | VideoBlock
  | PicturesBlock
  | CountdownBlock
  | ProductBlock
  | QuotesBlock
  | FormBlock
  | RowBlock
  | BookingBlock
);

export type SalesPage = {
  blocks: PageBlock[];
  /**
   * The language the page's words are in, when it is known: set when the
   * page is made in the studio (the store's language) and when it is
   * translated (the language asked for). A page made before has none, and
   * nothing is guessed for it.
   */
  lang?: LanguageCode;
  /** The title a search engine and a shared link show; empty is "<product> — <store>". */
  seoTitle: string;
  /** The line under it; empty is the product's summary or the start of its description. */
  seoDescription: string;
  /**
   * For a free product: a paid product of the same store shown to whoever
   * has just asked for the free one, with a link to its own page. Null is
   * none. Nothing is charged or added for them; it is a link.
   */
  next: string | null;
  /**
   * A second headline and line under it, tested against the hero's own
   * (lib/headline-test.ts). Null is no test. The id changes whenever the
   * words of either version change, so a test is never scored on words it
   * did not show.
   */
  test: HeadlineTest | null;
  /**
   * A second version of the whole page, tested against this one (added
   * 10 October 2026, lib/headline-test.ts): its own blocks, in its own order.
   * Null is no test. A page runs one test at a time, so with a second
   * version there is no headline test. Its id changes whenever what either
   * version shows changes, so a test is never scored on a page it did not
   * show. Pictures may be shared by the two versions, and the two together
   * hold no more than one page may.
   */
  variant: PageVariant | null;
  /**
   * How the sections below the hero are set off from each other (added
   * 8 October 2026): "plain" on the page itself, "bands" every other one on
   * a wash of the store's colour, "cards" each on a card of its own. Only the
   * look changes; the words, the order and what is counted stay the same.
   */
  style: PageStyle;
  /**
   * Kept from visitors while the creator works on it (added 8 October
   * 2026): the product's plain page shows instead, with its own title and
   * description, and nothing on this page is answered from or counted.
   */
  hidden: boolean;
  /**
   * For a hidden page, the moment it shows by itself, in seconds (added
   * 8 October 2026): a launch at nine on Monday without anyone at the
   * keyboard. 0 is none; the page then stays hidden until switched on.
   */
  showFrom: number;
};

/** The page visitors are shown at `now` (seconds): this one, or none while it is hidden and not yet due. */
export function livePage(page: SalesPage, now = Math.floor(Date.now() / 1000)): SalesPage {
  const due = page.showFrom > 0 && now >= page.showFrom;
  return page.hidden && !due ? { ...EMPTY_PAGE, blocks: [] } : page;
}

/** Whether visitors see the page at `now`. */
export function pageShown(page: SalesPage, now = Math.floor(Date.now() / 1000)): boolean {
  return !page.hidden || (page.showFrom > 0 && now >= page.showFrom);
}

export const PAGE_STYLES = ["plain", "bands", "cards"] as const;
export type PageStyle = (typeof PAGE_STYLES)[number];

/** Whether a section, the `index`-th shown below the hero, sits on a band. */
export function onBand(style: PageStyle, index: number): boolean {
  return style === "bands" && index % 2 === 0;
}

/**
 * Which of the sections shown sit on a band, counted apart for phones and
 * for larger screens, so the bands still alternate on each when a block
 * shows on only one of them.
 */
export function bandsOf(style: PageStyle, blocks: { screens?: BlockShow }[]): { phone: boolean; computer: boolean }[] {
  let phone = 0;
  let computer = 0;
  return blocks.map((block) => {
    const onPhone = block.screens !== "computer";
    const onComputer = block.screens !== "phone";
    const out = { phone: onPhone && onBand(style, phone), computer: onComputer && onBand(style, computer) };
    if (onPhone) phone += 1;
    if (onComputer) computer += 1;
    return out;
  });
}

/**
 * What a test is measured by, declared when it is saved (lib/headline-test-rules.ts,
 * rule 2): money for a product sold, sign-ups for a free one. Absent on a
 * test saved before 18 October 2026.
 */
export type TestMeasure = "money" | "checkouts";
export type HeadlineTest = { id: string; headline: string; sub: string; measure?: TestMeasure };
export type PageVariant = { id: string; blocks: PageBlock[]; measure?: TestMeasure };

/** A measure as stored or sent: one of the two, or none. */
export function parseMeasure(raw: unknown): TestMeasure | undefined {
  return raw === "money" || raw === "checkouts" ? raw : undefined;
}

/** The measure a page's running test was saved with, or null when it has none or was saved before measures were. */
export function declaredMeasure(page: Pick<SalesPage, "test" | "variant">): TestMeasure | null {
  return (page.variant ? page.variant.measure : page.test?.measure) ?? null;
}

/**
 * The page as it is saved: its running test declares the measure it will be
 * decided by. A test already running with the same id keeps the measure it
 * started with, so changing the price mid-test cannot change what it is
 * scored on; a new test takes the product's measure now.
 */
export function declareMeasure(page: SalesPage, before: Pick<SalesPage, "test" | "variant"> | null, measure: TestMeasure): SalesPage {
  // What the browser sent is never taken: the measure is the server's alone.
  const of = (id: string): TestMeasure | undefined => {
    if (before?.variant?.id === id) return before.variant.measure;
    if (before?.test?.id === id) return before.test.measure;
    return measure;
  };
  if (page.variant) {
    const { measure: _sent, ...variant } = page.variant;
    void _sent;
    const m = of(variant.id);
    return { ...page, variant: m ? { ...variant, measure: m } : variant };
  }
  if (page.test) {
    const { measure: _sent, ...test } = page.test;
    void _sent;
    const m = of(test.id);
    return { ...page, test: m ? { ...test, measure: m } : test };
  }
  return page;
}

export const EMPTY_PAGE: SalesPage = { blocks: [], seoTitle: "", seoDescription: "", next: null, test: null, variant: null, style: "plain", hidden: false, showFrom: 0 };

/** What two lists of blocks show, without the ids that only tell blocks apart. */
function shownOf(blocks: PageBlock[]): string {
  return JSON.stringify(
    blocks.map((block) => {
      const rest: Partial<PageBlock> = { ...block };
      delete rest.id;
      return rest;
    }),
  );
}

/** Whether two versions of a page show the same thing. */
export function sameBlocks(a: PageBlock[], b: PageBlock[]): boolean {
  return shownOf(a) === shownOf(b);
}

/** The id of a test of these two whole versions: the same page shown, the same id. */
export function variantId(a: PageBlock[], b: PageBlock[]): string {
  return `p${testId({ headline: shownOf(a), sub: "" }, { headline: shownOf(b), sub: "" })}`;
}

/** The test a page runs, by id: a second version of the whole page, or a second headline; null when none. */
export function runningTest(page: Pick<SalesPage, "test" | "variant">): string | null {
  return page.variant?.id ?? page.test?.id ?? null;
}

/**
 * The page as one version of its test shows it: the second version's own
 * blocks, or the hero with the second headline. Everything else about the
 * page — its title for search engines, its look, what is sold and at what
 * price — is the same for both.
 */
export function asVersion(page: SalesPage, version: "a" | "b"): SalesPage {
  if (version === "a") return page;
  if (page.variant) return { ...page, blocks: page.variant.blocks };
  const [first, ...others] = page.blocks;
  if (page.test && first?.kind === "hero") return { ...page, blocks: [{ ...first, headline: page.test.headline, sub: page.test.sub }, ...others] };
  return page;
}

/** Whether a page, and a second version of it, each weigh no more than a page may. */
export function oversized(page: SalesPage): boolean {
  if (JSON.stringify({ ...page, variant: null }).length > MAX_PAGE_BYTES) return true;
  return page.variant !== null && JSON.stringify(page.variant).length > MAX_PAGE_BYTES;
}

/** The id of a test of these two versions: the same words, the same id. */
export function testId(a: { headline: string; sub: string }, b: { headline: string; sub: string }): string {
  const text = JSON.stringify([a.headline, a.sub, b.headline, b.sub]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36).padStart(7, "0").slice(0, 8);
}

export const BLOCK_ID_PATTERN = /^[a-z0-9]{4,12}$/;
const PRODUCT_ID_PATTERN = /^[a-z0-9]{6,40}$/;

/** One line: control characters and runs of space made one space. */
function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Several lines, as a message box writes them: line endings made one kind,
 * control characters other than the line break dropped, space at line ends
 * trimmed, no more than one blank line in a row.
 */
function lines(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, " ")
    .split("\n")
    .map((row) => row.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** A fresh block id: eight lower-case letters and digits. */
export function newBlockId(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += letters[byte % letters.length];
  return out;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;
const LOOM_ID = /^[0-9a-f]{32}$/;

/**
 * Reads a video address the way people copy it — the address bar, the share
 * button, an embed code's src — and keeps only which player and which video.
 * Anything that is not one of the three players, over https or http, is not
 * a video here, and comes back null.
 */
export function readVideo(raw: string): Video | null {
  const text = raw.trim().slice(0, 500);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    const id =
      parts[0] === "watch" || parts.length === 0
        ? url.searchParams.get("v") ?? ""
        : ["embed", "shorts", "live", "v"].includes(parts[0])
          ? parts[1] ?? ""
          : "";
    return YOUTUBE_ID.test(id) ? { provider: "youtube", id, hash: "" } : null;
  }
  if (host === "youtu.be") {
    const id = parts[0] ?? "";
    return YOUTUBE_ID.test(id) ? { provider: "youtube", id, hash: "" } : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    // vimeo.com/123456789, vimeo.com/123456789/abcdef1234 (an unlisted
    // video's key), player.vimeo.com/video/123456789?h=abcdef1234.
    const at = host === "player.vimeo.com" ? (parts[0] === "video" ? 1 : -1) : parts.findIndex((p) => VIMEO_ID.test(p));
    const id = at >= 0 ? parts[at] ?? "" : "";
    if (!VIMEO_ID.test(id)) return null;
    const after = parts[at + 1] ?? "";
    const given = url.searchParams.get("h") ?? (VIMEO_HASH.test(after) ? after : "");
    return { provider: "vimeo", id, hash: VIMEO_HASH.test(given) ? given : "" };
  }
  if (host === "loom.com") {
    const id = (parts[0] === "share" || parts[0] === "embed") ? parts[1] ?? "" : "";
    return LOOM_ID.test(id) ? { provider: "loom", id, hash: "" } : null;
  }
  return null;
}

/** The only frame addresses a page ever gets, one per player, built from the id alone. */
export function embedUrl(video: Video, { autoplay = true }: { autoplay?: boolean } = {}): string {
  // Off only for a visitor who asked for less motion (components/video-window.tsx): the player loads and waits for its own play button.
  const play = autoplay ? 1 : 0;
  if (video.provider === "youtube") {
    // enablejsapi lets the page hear where the player is, for how far the video is watched (components/page-depth.tsx).
    return `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=${play}&rel=0&modestbranding=1&enablejsapi=1`;
  }
  if (video.provider === "vimeo") {
    return `https://player.vimeo.com/video/${video.id}?dnt=1&autoplay=${play}${video.hash ? `&h=${video.hash}` : ""}`;
  }
  return `https://www.loom.com/embed/${video.id}?autoplay=${play}&hide_owner=true&hide_share=true&hide_title=true`;
}

/** The address a person would open the video at, for the studio's field. */
export function videoAddress(video: Video): string {
  if (video.provider === "youtube") return `https://www.youtube.com/watch?v=${video.id}`;
  if (video.provider === "vimeo") return `https://vimeo.com/${video.id}${video.hash ? `/${video.hash}` : ""}`;
  return `https://www.loom.com/share/${video.id}`;
}

export const PROVIDER_NAMES: Record<VideoProvider, string> = { youtube: "YouTube", vimeo: "Vimeo", loom: "Loom" };

/** The frame origins the page policy lets in (lib/csp.ts), and nothing else. */
export const VIDEO_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com", "https://www.loom.com"];

/** A video as it was kept, made safe to use; null when it is not one. Also read by lib/community-events.ts. */
export function parseVideo(raw: unknown): Video | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  const hash = typeof value.hash === "string" && VIMEO_HASH.test(value.hash) ? value.hash : "";
  if (value.provider === "youtube" && YOUTUBE_ID.test(id)) return { provider: "youtube", id, hash: "" };
  if (value.provider === "vimeo" && VIMEO_ID.test(id)) return { provider: "vimeo", id, hash };
  if (value.provider === "loom" && LOOM_ID.test(id)) return { provider: "loom", id, hash: "" };
  return null;
}

const PICTURE_PATH = /^images\/[0-9a-f]{24}\/[0-9a-f]{32}\.(webp|jpg)$/;

/** One picture as it was kept, made safe to use; null when it is not one. */
export function parsePicture(raw: unknown): Picture | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== "string" || !PICTURE_PATH.test(value.path)) return null;
  const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 0);
  const width = side(value.width);
  const height = side(value.height);
  if (!width || !height) return null;
  return { path: value.path, width, height, alt: line(value.alt, 150), caption: line(value.caption, MAX_PICTURE_CAPTION) };
}

/** The moment a countdown runs to, in seconds: a whole number in a sane range, else 0. */
function parseUntil(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 1_600_000_000 && raw < 4_102_444_800 ? raw : 0;
}

/** The pictures one block shows: a pictures block's, a picture beside words, or a row's pictures. */
export function picturesOf(block: PageBlock): Picture[] {
  if (block.kind === "pictures") return block.items;
  if (block.kind === "feature" && block.picture) return [block.picture];
  if (block.kind === "row") return block.columns.flatMap((column) => column.flatMap((element) => (element.kind === "image" ? [element.picture] : [])));
  return [];
}

/**
 * How many pictures every block but the one at `index` shows, by picturesOf
 * (a row's included): what the editor takes from MAX_PAGE_PICTURES before it
 * offers room for one more, so it never offers what the save then refuses.
 */
export function picturesOutside(blocks: readonly PageBlock[], index: number): number {
  return blocks.reduce((n, block, i) => (i === index ? n : n + picturesOf(block).length), 0);
}

/**
 * One element of a row, made safe to use; null when it cannot be one: an
 * unknown kind, no words where words are the element, an icon not on the
 * list, a button address that is not https (javascript:, data: and the
 * like are never links), a picture that is not one of the store's own or
 * that has no description and is not marked decorative, a video that is not
 * one of the three players.
 */
export function parseRowElement(raw: unknown): RowElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case "heading": {
      const text = line(value.text, MAX_HEADING);
      return text ? { kind: "heading", text } : null;
    }
    case "subheading": {
      const text = line(value.text, MAX_SUBHEADLINE);
      return text ? { kind: "subheading", text } : null;
    }
    case "paragraph": {
      const text = lines(value.text, MAX_ROW_PARAGRAPH);
      return text ? { kind: "paragraph", text } : null;
    }
    case "list": {
      const items = Array.isArray(value.items) ? value.items.map((item) => line(item, MAX_ITEM)).filter(Boolean).slice(0, MAX_ROW_LIST_ITEMS) : [];
      return items.length ? { kind: "list", items } : null;
    }
    case "icon": {
      const name = (ROW_ICONS as readonly unknown[]).includes(value.name) ? (value.name as RowIcon) : null;
      return name ? { kind: "icon", name, label: line(value.label, MAX_ICON_LABEL) } : null;
    }
    case "button": {
      const label = line(value.label, MAX_CTA_LABEL);
      const sent = typeof value.url === "string" ? value.url.trim() : "";
      if (!sent) return { kind: "button", label, url: "" };
      const url = quoteUrl(sent);
      return url && label ? { kind: "button", label, url } : null;
    }
    case "image": {
      const picture = parsePicture(value.picture);
      if (!picture) return null;
      if (value.decorative === true) return { kind: "image", picture: { ...picture, alt: "" }, decorative: true };
      return picture.alt ? { kind: "image", picture, decorative: false } : null;
    }
    case "video": {
      const video = parseVideo(value.video);
      return video ? { kind: "video", video, title: line(value.title, MAX_HEADING) } : null;
    }
    case "video-window": {
      const video = parseVideo(value.video);
      const label = line(value.label, MAX_CTA_LABEL);
      return video && label ? { kind: "video-window", video, title: line(value.title, MAX_HEADING), label } : null;
    }
    default:
      return null;
  }
}

/**
 * A row's columns, made safe to use; null when the row is not one: not one
 * to three columns, or a column that is not a list. Elements that cannot be
 * one are dropped, each column keeps at most MAX_COLUMN_ELEMENTS, and the
 * row at most MAX_ROW_ELEMENTS, counted in reading order.
 */
function parseRowColumns(raw: unknown): RowElement[][] | null {
  if (!Array.isArray(raw) || raw.length < MIN_ROW_COLUMNS || raw.length > MAX_ROW_COLUMNS) return null;
  if (!raw.every((column) => Array.isArray(column))) return null;
  let room = MAX_ROW_ELEMENTS;
  return (raw as unknown[][]).map((column) => {
    const kept = column
      .slice(0, MAX_COLUMN_ELEMENTS * 2)
      .map(parseRowElement)
      .filter((element): element is RowElement => element !== null)
      .slice(0, Math.min(MAX_COLUMN_ELEMENTS, room));
    room -= kept.length;
    return kept;
  });
}

/**
 * Whether one element is kept with every word it was sent with: what was
 * sent, made one line or several the same way the reading makes it but
 * never cut short, is what was kept. A list's empty lines are left out
 * before its points are counted, here as in parseRowElement.
 */
function rowElementWhole(raw: unknown, kept: RowElement): boolean {
  const value = raw as Record<string, unknown>;
  const whole = (text: unknown) => line(text, Infinity);
  switch (kept.kind) {
    case "heading":
    case "subheading":
      return whole(value.text) === kept.text;
    case "paragraph":
      return lines(value.text, Infinity) === kept.text;
    case "list": {
      const sent = Array.isArray(value.items) ? value.items.map(whole).filter(Boolean) : [];
      return sent.length === kept.items.length && sent.every((item, i) => item === kept.items[i]);
    }
    case "icon":
    case "button":
      return whole(value.label) === kept.label;
    case "image": {
      const picture = (value.picture ?? {}) as Record<string, unknown>;
      // A picture marked as decoration has its description taken out on purpose.
      return whole(picture.caption) === kept.picture.caption && (kept.decorative || whole(picture.alt) === kept.picture.alt);
    }
    case "video":
      return whole(value.title) === kept.title;
    case "video-window":
      return whole(value.title) === kept.title && whole(value.label) === kept.label;
  }
}

/** Whether a row as sent keeps every element it was sent with, whole, within the limits: what blocksProblem tells back. */
function rowSentWhole(raw: Record<string, unknown>): boolean {
  const columns = raw.columns;
  if (!Array.isArray(columns) || columns.length < MIN_ROW_COLUMNS || columns.length > MAX_ROW_COLUMNS) return false;
  if (!columns.every((column) => Array.isArray(column) && column.length <= MAX_COLUMN_ELEMENTS)) return false;
  const all = (columns as unknown[][]).flat();
  if (all.length > MAX_ROW_ELEMENTS) return false;
  return all.every((element) => {
    const kept = parseRowElement(element);
    return kept !== null && rowElementWhole(element, kept);
  });
}

/** Whether a booking block as sent can be kept whole: a call's id, and no heading or one within MAX_HEADING (never cut short). */
function bookingSentWhole(raw: Record<string, unknown>): boolean {
  if (typeof raw.product !== "string" || !PRODUCT_ID_PATTERN.test(raw.product)) return false;
  if (raw.heading === undefined) return true;
  return typeof raw.heading === "string" && line(raw.heading, Infinity).length <= MAX_HEADING;
}

/** Every picture file a page shows, each once: what is kept when the page is saved, and deleted when it is not. */
export function picturePaths(page: Pick<SalesPage, "blocks"> & { variant?: PageVariant | null }): string[] {
  const out: string[] = [];
  for (const block of [...page.blocks, ...(page.variant?.blocks ?? [])]) {
    for (const picture of picturesOf(block)) if (!out.includes(picture.path)) out.push(picture.path);
  }
  return out;
}

/** Whether a countdown still has time on it at `now` (in seconds). One that has run out is not drawn. */
export function countdownLive(block: Pick<CountdownBlock, "until">, now: number): boolean {
  return block.until > now;
}

/** One block, made safe to use; null when it cannot be one. */
function parseBlock(raw: unknown): PageBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && BLOCK_ID_PATTERN.test(value.id) ? value.id : "";
  if (!id) return null;
  const heading = line(value.heading, MAX_HEADING);
  switch (value.kind) {
    case "hero": {
      const video = parseVideo(value.video);
      const media = value.media === "video" && video ? "video" : value.media === "none" ? "none" : "picture";
      const hero: HeroBlock = { id, kind: "hero", headline: line(value.headline, MAX_HEADLINE), sub: lines(value.sub, MAX_SUBHEADLINE), media, video };
      if (value.layout === "centered" || value.layout === "cover") hero.layout = value.layout;
      if (value.button === true) hero.button = true;
      return hero;
    }
    case "text":
      return { id, kind: "text", heading, body: lines(value.body, MAX_TEXT) };
    case "benefits": {
      const items = Array.isArray(value.items) ? value.items.map((item) => line(item, MAX_ITEM)).filter(Boolean).slice(0, MAX_BENEFITS) : [];
      return { id, kind: "benefits", heading, items };
    }
    case "inside": {
      const items = Array.isArray(value.items)
        ? value.items
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return { title: line(row.title, MAX_ITEM), detail: lines(row.detail, MAX_ITEM_DETAIL) };
            })
            .filter((item) => item.title)
            .slice(0, MAX_INSIDE_ITEMS)
        : [];
      return { id, kind: "inside", heading, items };
    }
    case "bio":
      return { id, kind: "bio", heading, body: lines(value.body, MAX_BIO), photo: value.photo !== false };
    case "faq": {
      const items = Array.isArray(value.items)
        ? value.items
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return { q: line(row.q, MAX_QUESTION), a: lines(row.a, MAX_ANSWER) };
            })
            .filter((item) => item.q && item.a)
            .slice(0, MAX_FAQ_ITEMS)
        : [];
      return { id, kind: "faq", heading, items };
    }
    case "guarantee":
      return { id, kind: "guarantee", heading, body: lines(value.body, MAX_GUARANTEE) };
    case "cta":
      return { id, kind: "cta", label: line(value.label, MAX_CTA_LABEL), note: line(value.note, MAX_CTA_NOTE) };
    case "reviews": {
      const first = Array.isArray(value.first)
        ? [...new Set(value.first.filter((v): v is string => typeof v === "string" && REVIEW_ID_PATTERN.test(v)))].slice(0, MAX_PICKED_REVIEWS)
        : [];
      return { id, kind: "reviews", heading, first };
    }
    case "video":
      return { id, kind: "video", heading, video: parseVideo(value.video), caption: lines(value.caption, MAX_CAPTION) };
    case "pictures": {
      const seen = new Set<string>();
      const items = Array.isArray(value.items)
        ? value.items
            .map(parsePicture)
            .filter((picture): picture is Picture => {
              if (!picture || seen.has(picture.path)) return false;
              seen.add(picture.path);
              return true;
            })
            .slice(0, MAX_PICTURES)
        : [];
      return { id, kind: "pictures", heading, items };
    }
    case "countdown":
      return { id, kind: "countdown", heading: line(value.heading, MAX_COUNTDOWN_LABEL), until: parseUntil(value.until), note: line(value.note, MAX_COUNTDOWN_NOTE) };
    case "fit": {
      const list = (raw: unknown) => (Array.isArray(raw) ? raw.map((item) => line(item, MAX_ITEM)).filter(Boolean).slice(0, MAX_FIT_ITEMS) : []);
      return { id, kind: "fit", heading, yesLabel: line(value.yesLabel, MAX_HEADING), noLabel: line(value.noLabel, MAX_HEADING), yes: list(value.yes), no: list(value.no) };
    }
    case "steps":
    case "bonuses": {
      const max = value.kind === "steps" ? MAX_STEPS : MAX_BONUSES;
      const items = Array.isArray(value.items)
        ? value.items
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return { title: line(row.title, MAX_ITEM), detail: lines(row.detail, MAX_ITEM_DETAIL) };
            })
            .filter((item) => item.title)
            .slice(0, max)
        : [];
      return value.kind === "steps" ? { id, kind: "steps", heading, items } : { id, kind: "bonuses", heading, items };
    }
    case "compare": {
      const rows = Array.isArray(value.rows)
        ? value.rows
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return { label: line(row.label, MAX_ITEM), a: line(row.a, MAX_CELL), b: line(row.b, MAX_CELL) };
            })
            .filter((row) => row.label && (row.a || row.b))
            .slice(0, MAX_COMPARE_ROWS)
        : [];
      return { id, kind: "compare", heading, columnA: line(value.columnA, MAX_COLUMN), columnB: line(value.columnB, MAX_COLUMN), rows };
    }
    case "feature":
      return { id, kind: "feature", heading, body: lines(value.body, MAX_TEXT), picture: parsePicture(value.picture), side: value.side === "right" ? "right" : "left" };
    case "facts": {
      const known = new Set(FACT_KEYS.map((f) => f.key));
      const show = Array.isArray(value.show)
        ? FACT_KEYS.map((f) => f.key).filter((key) => (value.show as unknown[]).includes(key) && known.has(key))
        : [];
      return { id, kind: "facts", heading, show };
    }
    case "quotes": {
      const items = Array.isArray(value.items)
        ? value.items
            .map((item) => {
              const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
              return { text: lines(row.text, MAX_QUOTE), name: line(row.name, MAX_QUOTE_NAME), url: quoteUrl(row.url) };
            })
            .filter((item) => item.text && item.url)
            .slice(0, MAX_QUOTES)
        : [];
      return { id, kind: "quotes", heading, items };
    }
    case "product": {
      const product = typeof value.product === "string" && PRODUCT_ID_PATTERN.test(value.product) ? value.product : "";
      return { id, kind: "product", heading, product, note: line(value.note, MAX_PRODUCT_NOTE) };
    }
    case "form":
      return { id, kind: "form", heading, form: typeof value.form === "string" && /^[a-z0-9]{10}$/.test(value.form) ? value.form : "" };
    case "row": {
      const columns = parseRowColumns(value.columns);
      return columns ? { id, kind: "row", columns } : null;
    }
    // Kept whole or not at all: without a call it books nothing, and its heading is never cut short (blocksProblem tells it back).
    case "booking":
      return bookingSentWhole(value) ? { id, kind: "booking", product: value.product as string, heading } : null;
    default:
      return null;
  }
}

/**
 * One version's blocks, made safe to use: at most thirty known blocks with
 * unique ids, one hero at most and only at the top (it carries the page's
 * one main heading), one place for the reviews, and each picture shown once.
 * `pictures` holds the files kept so far across the page's versions, which
 * together hold no more than MAX_PAGE_PICTURES.
 */
function parseBlocks(list: unknown, pictures: Set<string>): PageBlock[] {
  const blocks: PageBlock[] = [];
  if (!Array.isArray(list)) return blocks;
  const seen = new Set<string>();
  const shown = new Set<string>();
  const room = (path: string) => !shown.has(path) && (pictures.has(path) || pictures.size < MAX_PAGE_PICTURES);
  const keep = (path: string) => {
    shown.add(path);
    pictures.add(path);
  };
  let reviews = false;
  let bookings = 0;
  for (const entry of list.slice(0, MAX_BLOCKS * 2)) {
    const block = parseBlock(entry);
    if (!block || seen.has(block.id)) continue;
    const screens = (entry as { screens?: unknown }).screens;
    if (block.kind !== "hero" && (screens === "phone" || screens === "computer")) block.screens = screens;
    const saved = (entry as { saved?: unknown }).saved;
    if (block.kind !== "hero" && typeof saved === "string" && SAVED_BLOCK_ID.test(saved)) block.saved = saved;
    const lang = (entry as { lang?: unknown }).lang;
    if (isLanguage(lang)) block.lang = lang;
    if (block.kind === "hero" && blocks.length > 0) continue;
    if (block.kind === "reviews") {
      if (reviews) continue;
      reviews = true;
    }
    if (block.kind === "booking") {
      if (bookings >= MAX_BOOKING_BLOCKS) continue;
      bookings += 1;
    }
    // Pictures are counted across the page, and one file is shown once.
    if (block.kind === "pictures") {
      block.items = block.items.filter((picture) => {
        if (!room(picture.path)) return false;
        keep(picture.path);
        return true;
      });
    }
    if (block.kind === "feature" && block.picture) {
      if (!room(block.picture.path)) block.picture = null;
      else keep(block.picture.path);
    }
    if (block.kind === "row") {
      block.columns = block.columns.map((column) =>
        column.filter((element) => {
          if (element.kind !== "image") return true;
          if (!room(element.picture.path)) return false;
          keep(element.picture.path);
          return true;
        }),
      );
    }
    seen.add(block.id);
    blocks.push(block);
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks;
}

/**
 * Whatever came back from storage or from the studio, made safe to use: its
 * blocks (parseBlocks), the product to show after a sign-up only when it
 * looks like an id, and one test at most — a second version of the whole
 * page, or else a second headline.
 */
export function parsePage(raw: unknown): SalesPage {
  if (!raw || typeof raw !== "object") return { ...EMPTY_PAGE, blocks: [] };
  const value = raw as Record<string, unknown>;
  const pictures = new Set<string>();
  const blocks = parseBlocks(value.blocks, pictures);
  const variant = parseVariant(value.variant, blocks, pictures);
  return {
    blocks,
    seoTitle: line(value.seoTitle, MAX_SEO_TITLE),
    seoDescription: line(value.seoDescription, MAX_SEO_DESCRIPTION),
    next: typeof value.next === "string" && PRODUCT_ID_PATTERN.test(value.next) ? value.next : null,
    test: variant ? null : parseTest(value.test, blocks[0]?.kind === "hero" ? blocks[0] : null),
    variant,
    style: (PAGE_STYLES as readonly unknown[]).includes(value.style) ? (value.style as PageStyle) : "plain",
    hidden: value.hidden === true,
    // Only for a hidden page, and only a moment a clock can hold.
    showFrom: value.hidden === true ? parseUntil(value.showFrom) : 0,
    ...(isLanguage(value.lang) ? { lang: value.lang } : {}),
  };
}

/**
 * A second version as stored or sent: kept only beside a page with blocks,
 * only when it has blocks of its own and shows something the first does
 * not, and always with the id what the two show gives it.
 */
function parseVariant(raw: unknown, first: PageBlock[], pictures: Set<string>): PageVariant | null {
  if (first.length === 0 || !raw || typeof raw !== "object") return null;
  const blocks = parseBlocks((raw as Record<string, unknown>).blocks, pictures);
  if (blocks.length === 0 || sameBlocks(first, blocks)) return null;
  const measure = parseMeasure((raw as Record<string, unknown>).measure);
  return { id: variantId(first, blocks), blocks, ...(measure ? { measure } : {}) };
}

/**
 * A headline test as stored or sent: kept only on a page with a hero, only
 * when the second headline is written and differs from the first, and always
 * with the id its words give it.
 */
function parseTest(raw: unknown, hero: HeroBlock | null): HeadlineTest | null {
  if (!hero || !raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const headline = line(value.headline, MAX_HEADLINE);
  const sub = lines(value.sub, MAX_SUBHEADLINE);
  if (!headline || (headline === hero.headline && sub === hero.sub)) return null;
  const measure = parseMeasure(value.measure);
  return { id: testId(hero, { headline, sub }), headline, sub, ...(measure ? { measure } : {}) };
}

/** What is wrong with a page the studio sent, in a word the studio can explain; null when nothing. */
export type PageProblem =
  | "too_many"
  | "hero_first"
  | "two_reviews"
  | "video"
  | "pictures"
  | "countdown"
  | "quote_link"
  | "quote_length"
  | "shape"
  | "too_big"
  | "same_version"
  | "row"
  | "booking"
  | null;

/** The rules of one version's blocks, told back; `kept` is that version as parsed. */
function blocksProblem(sent: unknown[], kept: PageBlock[]): PageProblem {
  if (sent.length > MAX_BLOCKS) return "too_many";
  const kinds = sent.map((b) => (b && typeof b === "object" ? (b as { kind?: unknown }).kind : null));
  if (kinds.slice(1).includes("hero")) return "hero_first";
  if (kinds.filter((k) => k === "reviews").length > 1) return "two_reviews";
  // One booking block a page, with a call chosen and its heading whole.
  if (kinds.filter((k) => k === "booking").length > MAX_BOOKING_BLOCKS) return "booking";
  for (const block of sent) {
    const value = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
    if (value.kind === "hero" && value.media === "video" && !parseVideo(value.video)) return "video";
    if (value.kind === "video" && !parseVideo(value.video)) return "video";
    // A countdown with no moment, or one too far away to be a deadline.
    if (value.kind === "countdown") {
      const until = parseUntil(value.until);
      if (!until || until > Date.now() / 1000 + MAX_COUNTDOWN_DAYS * 86_400) return "countdown";
    }
    // Something said elsewhere, written in, without the address where it was said.
    if (value.kind === "quotes" && Array.isArray(value.items)) {
      for (const item of value.items) {
        const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
        if (typeof row.text === "string" && row.text.trim().length > MAX_QUOTE) return "quote_length";
        if (typeof row.text === "string" && row.text.trim() && !quoteUrl(row.url)) return "quote_link";
      }
    }
    // A row with no columns or more than three, too many elements, or an element that cannot be kept as sent.
    if (value.kind === "row" && !rowSentWhole(value)) return "row";
    if (value.kind === "booking" && !bookingSentWhole(value)) return "booking";
  }
  // A picture sent that was not kept: not a picture, a second copy of one, or past what a page holds.
  const sentPictures = sent.reduce<number>((n, b) => {
    const value = b && typeof b === "object" ? (b as { kind?: unknown; items?: unknown; picture?: unknown; columns?: unknown }) : {};
    if (value.kind === "feature") return n + (value.picture ? 1 : 0);
    if (value.kind === "row" && Array.isArray(value.columns)) {
      const elements = value.columns.flatMap((column) => (Array.isArray(column) ? column : []));
      return n + elements.filter((element) => element && typeof element === "object" && (element as { kind?: unknown }).kind === "image").length;
    }
    const items = value.kind === "pictures" ? value.items : null;
    return n + (Array.isArray(items) ? items.length : 0);
  }, 0);
  if (sentPictures !== picturePaths({ blocks: kept }).length) return "pictures";
  if (kept.length !== sent.length) return "shape";
  return null;
}

/**
 * The same rules as parsePage, told back rather than quietly applied, so a
 * creator is never shown "saved" for a page that was saved differently.
 */
export function pageProblem(raw: { blocks?: unknown; variant?: unknown }, parsed: SalesPage): PageProblem {
  const problem = blocksProblem(Array.isArray(raw.blocks) ? raw.blocks : [], parsed.blocks);
  if (problem) return problem;
  if (raw.variant && typeof raw.variant === "object") {
    const sent = (raw.variant as { blocks?: unknown }).blocks;
    // A second version with nothing in it, or showing just what the first does, is no test.
    if (!parsed.variant) return "same_version";
    const second = blocksProblem(Array.isArray(sent) ? sent : [], parsed.variant.blocks);
    if (second) return second;
  }
  if (oversized(parsed)) return "too_big";
  return null;
}

/** A block with nothing in it yet, of the kind asked for. */
export function emptyBlock(kind: BlockKind, id = newBlockId()): PageBlock {
  switch (kind) {
    case "hero":
      return { id, kind, headline: "", sub: "", media: "picture", video: null };
    case "text":
      return { id, kind, heading: "", body: "" };
    case "benefits":
      return { id, kind, heading: "What you get", items: [] };
    case "inside":
      return { id, kind, heading: "What's inside", items: [] };
    case "bio":
      return { id, kind, heading: "", body: "", photo: true };
    case "faq":
      return { id, kind, heading: "Questions", items: [] };
    case "guarantee":
      return { id, kind, heading: "Guarantee", body: "" };
    case "cta":
      return { id, kind, label: "", note: "" };
    case "reviews":
      return { id, kind, heading: "Reviews", first: [] };
    case "video":
      return { id, kind, heading: "", video: null, caption: "" };
    case "pictures":
      return { id, kind, heading: "", items: [] };
    case "countdown":
      return { id, kind, heading: "", until: 0, note: "" };
    case "fit":
      return { id, kind, heading: "", yesLabel: "", noLabel: "", yes: [], no: [] };
    case "steps":
      return { id, kind, heading: "How it works", items: [] };
    case "compare":
      return { id, kind, heading: "", columnA: "", columnB: "", rows: [] };
    case "bonuses":
      return { id, kind, heading: "Also included", items: [] };
    case "facts":
      return { id, kind, heading: "", show: FACT_KEYS.map((f) => f.key) };
    case "feature":
      return { id, kind, heading: "", body: "", picture: null, side: "left" };
    case "product":
      return { id, kind, heading: "Goes well with it", product: "", note: "" };
    case "quotes":
      return { id, kind, heading: "What people say", items: [] };
    case "form":
      return { id, kind, heading: "", form: "" };
    case "row":
      return { id, kind, columns: [[], []] };
    case "booking":
      return { id, kind, product: "", heading: "" };
  }
}

/**
 * What the writing help drafts for a page (lib/ai.ts, writePage), in the
 * shape the browser receives it. Kept here, with the blocks, so the editor
 * can lay it out without importing anything that only the server loads.
 */
export type DraftCopy = {
  headline: string;
  sub: string;
  story: { heading: string; body: string } | null;
  benefits: string[];
  inside: { title: string; detail: string }[];
  faq: { q: string; a: string }[];
  guarantee: string;
  cta: string;
  seoTitle: string;
  seoDescription: string;
};

/**
 * A draft laid out as a page, in the order that sells: what it is, what the
 * buyer gets, why it exists, what is inside, a first button, the questions a
 * buyer still has, the creator's own refund promise when they gave one, a
 * last button, and the place for real buyers' reviews.
 *
 * Read back through parsePage, so a draft is held to every rule a page typed
 * by hand is. The hero keeps the product's picture when it has one: a page
 * drafted in words should not lose the picture the creator already chose.
 */
export function blocksFromDraft(draft: DraftCopy, picture: boolean): SalesPage {
  const blocks: Record<string, unknown>[] = [
    // With a button under the headline, for the reader who arrives ready.
    { id: newBlockId(), kind: "hero", headline: draft.headline, sub: draft.sub, media: picture ? "picture" : "none", video: null, button: true },
  ];
  if (draft.benefits.length) blocks.push({ id: newBlockId(), kind: "benefits", heading: "What you get", items: draft.benefits });
  if (draft.story) blocks.push({ id: newBlockId(), kind: "text", heading: draft.story.heading, body: draft.story.body });
  if (draft.inside.length) blocks.push({ id: newBlockId(), kind: "inside", heading: "What's inside", items: draft.inside });
  blocks.push({ id: newBlockId(), kind: "cta", label: draft.cta, note: "" });
  if (draft.faq.length) blocks.push({ id: newBlockId(), kind: "faq", heading: "Questions", items: draft.faq });
  if (draft.guarantee) blocks.push({ id: newBlockId(), kind: "guarantee", heading: "Guarantee", body: draft.guarantee });
  if (draft.faq.length || draft.inside.length) blocks.push({ id: newBlockId(), kind: "cta", label: draft.cta, note: "" });
  blocks.push({ id: newBlockId(), kind: "reviews", heading: "Reviews" });
  return parsePage({ blocks, seoTitle: draft.seoTitle, seoDescription: draft.seoDescription, next: null, test: null });
}

/**
 * Pages to start from (added 7 October 2026). Kajabi and Hotmart Pages open
 * on a gallery of templates; the page here used to open on an empty list, or
 * on the writing help. A template is only an order of blocks that sells that
 * kind of product, with its headings and the questions buyers of it ask. It
 * holds no sentence about the product: the headline and summary are the
 * product's own, every answer is the creator's to write, and a block left
 * empty is simply not drawn. Nothing here invents a claim.
 */
export type PageTemplate = { id: string; label: string; hint: string; free: boolean };

export const PAGE_TEMPLATES: PageTemplate[] = [
  { id: "guide", label: "Ebook, guide or templates", hint: "What they get, a look inside, the parts, the questions a buyer of a download asks.", free: false },
  { id: "course", label: "Course", hint: "A lesson to watch first, what they will be able to do, the lessons, who it is for, about you.", free: false },
  { id: "coaching", label: "Call or coaching", hint: "What you work on together, how it goes, about you, how the booking works.", free: false },
  { id: "membership", label: "Membership or community", hint: "What members get, what happens each month, when they are charged and how to cancel.", free: false },
  { id: "launch", label: "Launch with a deadline", hint: "A countdown to one real moment under the headline, then the offer, the questions and your promise.", free: false },
  { id: "free", label: "Free download", hint: "What is inside, who it is from, and what happens with their email.", free: true },
];

type TemplateBlock = Record<string, unknown> & { kind: BlockKind };

const questions = (...asked: string[]) => asked.map((q) => ({ q, a: "" }));

const TEMPLATE_BLOCKS: Record<string, TemplateBlock[]> = {
  guide: [
    { kind: "benefits", heading: "What you get" },
    { kind: "pictures", heading: "A look inside" },
    { kind: "inside", heading: "What's inside" },
    { kind: "fit" },
    { kind: "cta" },
    { kind: "faq", heading: "Questions", items: questions("What format is it in?", "How do I get it after paying?", "Can I get a refund?") },
    { kind: "guarantee", heading: "Guarantee" },
    { kind: "bio" },
    { kind: "cta" },
    { kind: "reviews", heading: "Reviews" },
  ],
  course: [
    { kind: "video", heading: "Watch a lesson first" },
    { kind: "facts" },
    { kind: "benefits", heading: "What you will be able to do" },
    { kind: "inside", heading: "The lessons" },
    { kind: "fit" },
    { kind: "bonuses", heading: "Also included" },
    { kind: "bio" },
    { kind: "cta" },
    { kind: "faq", heading: "Questions", items: questions("How long do I have access?", "How much time does it take?", "What if it is not for me?") },
    { kind: "guarantee", heading: "Guarantee" },
    { kind: "cta" },
    { kind: "reviews", heading: "Reviews" },
  ],
  coaching: [
    { kind: "benefits", heading: "What we work on" },
    { kind: "steps", heading: "How it goes" },
    { kind: "fit" },
    { kind: "bio" },
    { kind: "cta" },
    { kind: "faq", heading: "Questions", items: questions("How do we meet?", "Can I move my booking?", "What should I prepare?") },
    { kind: "reviews", heading: "Reviews" },
  ],
  membership: [
    { kind: "benefits", heading: "What members get" },
    { kind: "inside", heading: "What happens each month" },
    { kind: "fit" },
    { kind: "cta" },
    { kind: "faq", heading: "Questions", items: questions("When am I charged?", "Can I cancel at any time?", "What do I get the day I join?") },
    { kind: "bio" },
    { kind: "cta" },
    { kind: "reviews", heading: "Reviews" },
  ],
  launch: [
    { kind: "countdown", heading: "" },
    { kind: "benefits", heading: "What you get" },
    { kind: "inside", heading: "What's inside" },
    { kind: "cta" },
    { kind: "faq", heading: "Questions", items: questions("What changes when the countdown ends?", "How do I get it after paying?", "Can I get a refund?") },
    { kind: "guarantee", heading: "Guarantee" },
    { kind: "cta" },
    { kind: "reviews", heading: "Reviews" },
  ],
  free: [
    { kind: "benefits", heading: "What is inside" },
    { kind: "bio" },
    { kind: "faq", heading: "Questions", items: questions("Is it really free?", "What happens with my email?") },
  ],
};

/**
 * A template's blocks for one product: the hero from the product's own title
 * and summary (with its picture when it has one), then the template's blocks
 * with fresh ids. Not read through parsePage, which would drop the questions
 * still waiting for their answers; the page is held to every rule when it is
 * saved, like one built by hand.
 */
/** The kinds of block a template lays out, in order after its hero: what the gallery shows of it. */
export function templateOutline(id: string): BlockKind[] {
  return (TEMPLATE_BLOCKS[id] ?? []).map((row) => row.kind);
}

export function blocksFromTemplate(id: string, product: { title: string; summary: string; picture: boolean }): PageBlock[] {
  const rows = TEMPLATE_BLOCKS[id];
  if (!rows) return [];
  const hero: HeroBlock = {
    id: newBlockId(),
    kind: "hero",
    headline: product.title.slice(0, MAX_HEADLINE),
    sub: product.summary.slice(0, MAX_SUBHEADLINE),
    media: product.picture ? "picture" : "none",
    video: null,
    // A button under the headline from the start: the reader who arrives ready need not scroll.
    button: true,
  };
  return [hero, ...rows.map((row) => ({ ...emptyBlock(row.kind), ...row, id: newBlockId() }) as PageBlock)];
}

/**
 * A page with only the pictures in `keep`, and how many it lost: an earlier
 * version brought back shows only pictures whose files are still kept, since
 * a picture taken off a page is deleted when the page is saved without it.
 */
export function keepPictures(page: SalesPage, keep: ReadonlySet<string>): { page: SalesPage; dropped: number } {
  let dropped = 0;
  const blocks = page.blocks.map((block): PageBlock => {
    if (block.kind === "pictures") {
      const items = block.items.filter((picture) => keep.has(picture.path));
      dropped += block.items.length - items.length;
      return { ...block, items };
    }
    if (block.kind === "feature" && block.picture && !keep.has(block.picture.path)) {
      dropped += 1;
      return { ...block, picture: null };
    }
    if (block.kind === "row") {
      const columns = block.columns.map((column) => column.filter((element) => element.kind !== "image" || keep.has(element.picture.path)));
      dropped += picturesOf(block).length - picturesOf({ ...block, columns }).length;
      return { ...block, columns };
    }
    return block;
  });
  return { page: { ...page, blocks }, dropped };
}

/**
 * Another product's page, as a start for this one (added 8 October 2026):
 * the same blocks in the same order with fresh ids, its words and videos
 * kept, and its pictures left out. A picture belongs to the one page that
 * shows it (lib/sales-page-store.ts, claimPictures) and is deleted with it,
 * so a copy that pointed at the same files would lose them the day the
 * first page let them go. Nothing that is the other product's alone comes
 * across: its search title and line, its headline test, what it shows after
 * a sign-up. Returns how many pictures were left out, so the editor can say.
 */
export function copyOfPage(page: SalesPage): { blocks: PageBlock[]; picturesLeft: number; style: PageStyle } {
  let picturesLeft = 0;
  const blocks = page.blocks.map((block): PageBlock => {
    const id = newBlockId();
    if (block.kind === "pictures") {
      picturesLeft += block.items.length;
      return { ...block, id, items: [] };
    }
    if (block.kind === "feature" && block.picture) {
      picturesLeft += 1;
      return { ...block, id, picture: null };
    }
    if (block.kind === "row") {
      picturesLeft += picturesOf(block).length;
      return { ...block, id, columns: block.columns.map((column) => column.filter((element) => element.kind !== "image")) };
    }
    return { ...block, id } as PageBlock;
  });
  return { blocks, picturesLeft, style: page.style };
}
