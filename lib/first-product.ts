/**
 * A first product made inside Marktmorgen (490 [PP1], unit 1, added
 * 1 November 2026): the four formats, the questions asked as buttons, and
 * the outline each format starts from.
 *
 * The creator picks a format (a guide, a checklist, a workbook or a
 * template), answers at most five questions by tapping, and types what they
 * know about the subject. This file turns those answers into the outline:
 * the headings, and under each one what the creator is asked to write,
 * never anything written for them. On the Store plan, which has no AI
 * drafts, the outline is the product to fill in; on the other plans a later
 * unit has the AI draft each part from the creator's own words only, inside
 * the same outline.
 *
 * Nothing here is a fact about the creator's subject, a number, a study, a
 * testimonial or a promised result: the outline holds only the structure and
 * the creator's own words. Browser-safe: plain data and pure functions.
 */

export type FirstFormat = "guide" | "checklist" | "workbook" | "template";
export const FIRST_FORMATS: readonly FirstFormat[] = ["guide", "checklist", "workbook", "template"];

export type FirstChoice = { id: string; label: string };
/**
 * A question asked by buttons. `forAi`: its answer only shapes how the AI
 * writes (who it is for, how it sounds), so it is not asked where there is
 * no AI draft (the Store plan): a button that changes nothing is not shown.
 */
export type FirstQuestion = { id: string; ask: string; choices: FirstChoice[]; forAi?: boolean };

export type FormatInfo = {
  name: string;
  /** What it is, in a sentence a first-time creator understands. */
  what: string;
  /** The label of the one free field: what the creator knows about the subject. */
  know: string;
  /**
   * An example of an answer, shown as "For example: …" beside the field,
   * never put in it, never sent to a model, never kept.
   */
  example: string;
  questions: FirstQuestion[];
};

const LENGTH = (unit: string, short: string, medium: string, long: string): FirstQuestion => ({
  id: "length",
  ask: "How long should it be?",
  choices: [
    { id: "short", label: `Short: ${short} ${unit}` },
    { id: "medium", label: `Medium: ${medium} ${unit}` },
    { id: "long", label: `Long: ${long} ${unit}` },
  ],
});

const READER: FirstQuestion = {
  id: "reader",
  ask: "Who is it for?",
  forAi: true,
  choices: [
    { id: "new", label: "People just starting out" },
    { id: "some", label: "People with some experience" },
    { id: "pro", label: "People who do this for work" },
  ],
};

const TONE: FirstQuestion = {
  id: "tone",
  ask: "How should it sound?",
  forAi: true,
  choices: [
    { id: "friendly", label: "Friendly and warm" },
    { id: "direct", label: "Short and direct" },
    { id: "formal", label: "Careful and formal" },
  ],
};

export const FORMAT_INFO: Readonly<Record<FirstFormat, FormatInfo>> = {
  guide: {
    name: "Guide",
    what: "A short book that walks the reader through something you know, step by step.",
    know: "What do you know about this, in your own words?",
    example: "I plan our family dinners every Sunday. I shop once, cook a few bases and mix them into meals for the week.",
    questions: [
      READER,
      LENGTH("steps", "3", "5", "8"),
      TONE,
      {
        id: "ending",
        ask: "How should it end?",
        choices: [
          { id: "summary", label: "A one-page summary" },
          { id: "next", label: "What to do next" },
          { id: "none", label: "No ending page" },
        ],
      },
    ],
  },
  checklist: {
    name: "Checklist",
    what: "A list the reader checks off, so nothing is forgotten.",
    know: "What has to be done, or checked, in your own words?",
    example: "Before a craft fair: pack the table cloth, price every item, charge the card reader, bring change and a sign.",
    questions: [
      READER,
      LENGTH("items", "10", "20", "40"),
      {
        id: "groups",
        ask: "Should the items be in groups?",
        choices: [
          { id: "one", label: "One list" },
          { id: "stages", label: "Grouped by stage: before, during, after" },
          { id: "topics", label: "Grouped by topic, named by you" },
        ],
      },
    ],
  },
  workbook: {
    name: "Workbook",
    what: "Exercises the reader does on the page, with room to write their answers.",
    know: "What should the reader practice or think through, in your own words?",
    example: "Finding clients: who you help, where they spend their time, what you say in your first message.",
    questions: [
      READER,
      LENGTH("exercises", "3", "6", "10"),
      TONE,
      {
        id: "answers",
        ask: "Room for the reader's answers?",
        choices: [
          { id: "lines", label: "Lines to write on" },
          { id: "boxes", label: "Boxes to fill in" },
          { id: "both", label: "Both" },
        ],
      },
    ],
  },
  template: {
    name: "Template",
    what: "A ready page the reader copies and fills in with their own details.",
    know: "What is the template for, and what goes in it, in your own words?",
    example: "A one-page wedding budget: venue, food, music, flowers, clothes, and a total at the bottom.",
    questions: [
      {
        id: "use",
        ask: "How will people use it?",
        choices: [
          { id: "print", label: "Print it and fill it in by hand" },
          { id: "type", label: "Fill it in on a computer" },
          { id: "both", label: "Either" },
        ],
      },
      LENGTH("sections", "3", "5", "8"),
      READER,
    ],
  },
};

/** At most five questions, all by buttons (the item's own limit). */
export const FIRST_MAX_QUESTIONS = 5;

export type FirstAnswers = Partial<Record<string, string>>;

/** The questions asked: all of them with AI drafts, only those that change the outline without. */
export function questionsFor(format: FirstFormat, ai: boolean): FirstQuestion[] {
  return FORMAT_INFO[format].questions.filter((question) => ai || !question.forAi);
}

/**
 * The buttons marked when the screen opens: the first of each question. The
 * screen draws its starting state from this, so an answer the creator did
 * not see marked is never used.
 */
export function defaultAnswers(format: FirstFormat): Record<string, string> {
  return Object.fromEntries(FORMAT_INFO[format].questions.map((question) => [question.id, question.choices[0].id]));
}

/** The answer to each question, or its marked first button where none other was tapped. */
export function answered(format: FirstFormat, answers: FirstAnswers): Record<string, string> {
  const out = defaultAnswers(format);
  for (const question of FORMAT_INFO[format].questions) {
    const given = answers[question.id];
    if (question.choices.some((choice) => choice.id === given)) out[question.id] = given as string;
  }
  return out;
}

/** How many parts each length makes: the numbers in the length buttons' own labels. */
const PARTS: Record<FirstFormat, Record<string, number>> = {
  guide: { short: 3, medium: 5, long: 8 },
  checklist: { short: 10, medium: 20, long: 40 },
  workbook: { short: 3, medium: 6, long: 10 },
  template: { short: 3, medium: 5, long: 8 },
};

/**
 * One part of the outline: a heading, what the creator writes under it, and,
 * for a checklist in groups, the group it is in (a heading of its own in
 * the PDF, with its items as a list under it).
 */
export type FirstPart = { heading: string; ask: string; kind: "text" | "item" | "exercise" | "field"; group?: number };
export type FirstOutline = {
  format: FirstFormat;
  title: string;
  /** The creator's own words from the free field, kept as typed, for them to work from. */
  notes: string;
  /** The answers it was made from, so the screen and the PDF draw what was chosen. */
  answers: Record<string, string>;
  /** A checklist's groups, by name; the creator can rename them. Empty for one list. */
  groups: string[];
  parts: FirstPart[];
};

const GROUP_NAMES: Record<string, string[]> = { stages: ["Before", "During", "After"], topics: ["Topic one", "Topic two", "Topic three"] };
const ANSWER_ROOM: Record<string, string> = {
  lines: "The question or task, then lines for the reader's answer.",
  boxes: "The question or task, then boxes for the reader to fill in.",
  both: "The question or task, then lines and boxes for the reader's answer.",
};
const FIELD_USE: Record<string, string> = {
  print: "Name the section and the lines that go in it, with room to write by hand.",
  type: "Name the section and the fields that go in it, to type into.",
  both: "Name the section and the lines that go in it, to print or to type into.",
};

/** The first characters of a text, never cutting a letter or an emoji in two. */
const firstOf = (text: string, most: number) => Array.from(text.trim()).slice(0, most).join("");

/**
 * The outline for a format, its answers, the creator's title and what they
 * typed in the free field. Only structure and the creator's own words: a
 * missing title is a placeholder that asks for one, which publishing refuses.
 */
export function outlineFor(format: FirstFormat, answers: FirstAnswers, title = "", know = ""): FirstOutline {
  const a = answered(format, answers);
  const count = PARTS[format][a.length];
  const named = firstOf(title, 120) || placeholderTitle(format);
  const parts: FirstPart[] = [];
  let groups: string[] = [];
  if (format === "guide") {
    parts.push({ heading: "Who this is for", ask: "Say who this guide is for and what it covers. Say only what you can stand behind.", kind: "text" });
    for (let i = 1; i <= count; i += 1) parts.push({ heading: `Step ${i}`, ask: "Name the step, then say what to do and why, in your own words.", kind: "text" });
    if (a.ending === "summary") parts.push({ heading: "Summary", ask: "The steps again, one line each.", kind: "text" });
    if (a.ending === "next") parts.push({ heading: "What to do next", ask: "One thing the reader can do today.", kind: "text" });
  } else if (format === "checklist") {
    groups = GROUP_NAMES[a.groups] ?? [];
    const sizes = groups.length ? groups.map((_, g) => Math.floor(count / groups.length) + (g < count % groups.length ? 1 : 0)) : [count];
    sizes.forEach((size, g) => {
      for (let i = 1; i <= size; i += 1) parts.push({ heading: `Item ${i}`, ask: "One thing to do or check, starting with a verb.", kind: "item", ...(groups.length ? { group: g } : {}) });
    });
  } else if (format === "workbook") {
    parts.push({ heading: "How to use this workbook", ask: "Say how long each exercise takes and what the reader needs.", kind: "text" });
    for (let i = 1; i <= count; i += 1) parts.push({ heading: `Exercise ${i}`, ask: ANSWER_ROOM[a.answers], kind: "exercise" });
  } else {
    parts.push({ heading: "How to fill this in", ask: "One or two sentences on how to use the template.", kind: "text" });
    for (let i = 1; i <= count; i += 1) parts.push({ heading: `Section ${i}`, ask: FIELD_USE[a.use], kind: "field" });
  }
  return { format, title: named, notes: firstOf(know, 4000), answers: a, groups, parts };
}

/** The title an outline has until the creator writes theirs; publishing refuses it. */
export function placeholderTitle(format: FirstFormat): string {
  return `Your ${FORMAT_INFO[format].name.toLowerCase()}'s title`;
}

/**
 * Price, as the screen shows it. The field starts empty: the creator types
 * the price. In US dollars only, the screen offers three starting points to
 * tap, none marked, under words drawn by the code that say where they come
 * from. In any other currency there are none, because no conversion is made
 * up. Nothing is published until the creator has typed or tapped a price.
 */
export const PRICE_WORDS = {
  range: "Suggested range: $4 to $35. You choose.",
  points: "Starting points from Marktmorgen, not what other sellers charge",
} as const;

const STARTING_POINTS_USD_CENTS = [900, 1900, 2900];

/** The starting points offered to tap for a store's currency: three in US dollars, none in any other. */
export function startingPoints(currency: string): number[] {
  return currency.toLowerCase() === "usd" ? [...STARTING_POINTS_USD_CENTS] : [];
}
