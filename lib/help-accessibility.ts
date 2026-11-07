/**
 * The help center's "Accessibility" section (274 [AX1] Part B.3, added
 * 6 November 2026): help for creators to make their store and what they sell
 * easier for everyone to use, so they can meet what is asked of them as
 * sellers. Plain text, like every help answer (lib/help-content.ts), so the
 * studio's help assistant answers from the same words.
 *
 * Only what the code does is said of Marktmorgen: the studio's two checks by
 * their own titles (components/store-access-check.tsx,
 * components/course-access-check.tsx), the button contrast every store gets
 * in the studio's own words (lib/store-access-check.ts, ACCESS_DONE_FOR_YOU),
 * and files handed over as uploaded apart from the stamping line
 * (lib/pdf-stamp.ts). The rest is the creator's own steps. No conformity,
 * certification or legal claim (AX274 Part A item 7); nothing is checked or
 * changed in a creator's file. No supplier, no AI call, no new cost: each
 * answer fits whole in what the help assistant reads of an answer
 * (tests/help-accessibility.test.ts).
 */
import type { HelpSection } from "@/lib/help-content";

/** The section's questions, so the studio and the tests name the same ones. */
export const ACCESS_HELP_QUESTIONS = {
  studio: "How does the studio help everyone use my store?",
  files: "How do I make my PDFs and ebooks accessible?",
  statement: "Can I put an accessibility statement on my store?",
} as const;

/**
 * A short statement a creator can paste into "Questions on your store page"
 * (lib/store-faq.ts): it fits one question and one answer there, and every
 * part in [brackets] is the creator's to change. It says what may still be
 * hard and promises no reply time.
 */
export const STORE_STATEMENT = {
  q: "Can everyone use this store?",
  a: "I want everyone to be able to buy here and use what I sell, including people who use a screen reader, captions or only a keyboard. What I have done: [for example, every product picture has a description and every video has captions]. What may still be hard: [for example, my older PDFs have no headings yet]. If something here is hard for you to use, email me at [your email address]. Tell me the page and what happened, and I will try to help, for example with another format. Last checked: [month and year].",
} as const;

const CONTRAST_DONE =
  "If a button color you pick is too light or too dark, we adjust it so the words on your buttons keep at least 7:1 contrast.";

export const ACCESS_HELP_SECTION: HelpSection = {
  id: "accessibility",
  emoji: "🙋",
  title: "Accessibility",
  blurb: "Help so more people can use your store and what you sell.",
  tone: "bg-lilac",
  items: [
    {
      q: ACCESS_HELP_QUESTIONS.studio,
      a: [
        "A screen reader is a program that reads a page aloud, for people who cannot see the screen well. Your studio has two checks for things a screen reader cannot work out alone.",
        "“Can everyone use your store?” checks the products on the first page of your store and the links on its page. It lists each product picture with no description. To add one, open the product and fill in “What the picture shows, for people who cannot see it”. It also lists each link whose words do not say where it goes, such as “Click here”.",
        "“Can everyone follow your lessons?” is at the top of each course's page in your studio. It lists the lesson videos with no captions. Captions show what is said in a video as text, for people who cannot hear it. You can upload captions as a .vtt or .srt file, or have AI write them. “Can I sell a course?” says how both work.",
        `Done for you on every store: ${CONTRAST_DONE}`,
        "The checks never change your words, pictures or videos. You write each description and caption yourself. They are not a full review of your store.",
      ],
    },
    {
      q: ACCESS_HELP_QUESTIONS.files,
      a: [
        "We hand your file to buyers as you uploaded it. The one change, if you switch on stamping, is the buyer's details: a line on each page of a PDF, or a hidden note inside an EPUB. So how easy a file is to read comes from how it was made. These steps help most, and they cost nothing.",
        "Write it in a word processor and use its heading styles, such as Heading 1 and Heading 2, for titles. Do not only make words big and bold. A screen reader lets people jump from heading to heading.",
        "Give each picture that carries meaning a short description, called alt text. Mark pictures that only decorate as decorative, so they are skipped.",
        "Keep words as real text. A scanned page or a picture of words cannot be read aloud, searched or made bigger without blur.",
        "Set the document's language. Give each table a header row. Write links that say where they go. Never show something by color alone, such as red for a wrong answer with no word beside it.",
        "When you save as PDF, choose the option that keeps the document's structure. Some programs call these tags. Then open the PDF and check its title, its headings and its reading order.",
        "For an ebook, an ebook file called an EPUB is often easier to read than a PDF. In an EPUB, the reader can make the text bigger, and it flows to fit their screen. A PDF keeps its page size.",
      ],
    },
    {
      q: ACCESS_HELP_QUESTIONS.statement,
      a: [
        "Yes, in your own words. An honest statement tells buyers what you did, what may still be hard and how to reach you. Do not promise more than you have checked.",
        "In your studio, under “Questions on your store page”, add the question and answer below. Change each part in [brackets]. It fits the space for one question.",
        `The question: ${STORE_STATEMENT.q}`,
        `The answer: ${STORE_STATEMENT.a}`,
        "Laws on this differ by country, and this is not legal advice.",
      ],
    },
  ],
};

/** Where the studio's check sends a creator for this help: always the same place (WCAG 3.2.6). */
export const ACCESS_HELP_HREF = `/help#${ACCESS_HELP_SECTION.id}`;
