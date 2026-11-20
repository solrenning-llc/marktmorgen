/**
 * What the public page /accessibility says (310 [AX2] §6, DA1), taken from
 * the records instead of typed again: the gaps (in their public words) and the
 * review counts from docs/accessibility-inventory.json, and the tests that run
 * on each proposed change from the CI's own workflows, each tied by
 * tests/accessibility-statement.test.ts to the scope its own script prints.
 * The page never says more than these prove: no conformity, certification or
 * comparison is claimed (AX274 Part A, item 7).
 */
import { createHash } from "node:crypto";
import inventory from "@/docs/accessibility-inventory.json";
import { STATEMENT_REVIEWS } from "@/lib/accessibility-statement-reviews";

/** A test that runs in the CI on each proposed change and every day, in the words the page uses, and where it runs. */
export type AccessibilityCheck = {
  name: string;
  what: string;
  /** The workflow that runs it. */
  workflow: string;
  /** The test script it runs. */
  script: string;
  /** Text that must be in the workflow or the script for the page's words to stay true. */
  proof: string[];
};

const ENGINES = "browser: [chromium, firefox, webkit]";
const AAA_RULES = ['"wcag2aaa"', '"color-contrast-enhanced"'];

export const ACCESSIBILITY_CHECKS: readonly AccessibilityCheck[] = [
  {
    name: "Public pages",
    what: "The home page, the price list and the sign-in page, at five screen widths from 320 to 1920 pixels, in Chromium, Firefox and WebKit, with automated checks that include the enhanced (AAA) contrast rule, plus wider text spacing, reduced motion, high contrast (forced colors) and a narrow screen.",
    workflow: ".github/workflows/accessibility-public-matrix.yml",
    script: "tests/e2e/accessibility-public-matrix.mjs",
    proof: [ENGINES, ...AAA_RULES, '["/","/pricing","/signin"]', "[320,390,768,1280,1920]", '"text-spacing","reduced-motion","forced-colors","reflow-320"'],
  },
  {
    name: "Signing up",
    what: "Asking for a store, confirming the email, opening the new empty studio and seeing the new store from outside, in Chromium, Firefox and WebKit, with test services only.",
    workflow: ".github/workflows/accessibility-signup-actions.yml",
    script: "tests/e2e/accessibility-signup-actions.mjs",
    proof: [ENGINES, '"color-contrast-enhanced"', "Real local request/captured fake email/explicit confirmation/new empty studio"],
  },
  {
    name: "The studio",
    what: "Thirteen studio screens, viewed only (nothing is saved), in Chromium, Firefox and WebKit: the studio's front page and its list of pages at five screen widths from 320 to 1920 pixels, and eleven more (the site, people, email, numbers, adding, forms, funnels, deals, reviews, the checkup and the team) on a narrow and a wide screen.",
    workflow: ".github/workflows/accessibility-studio-matrix.yml",
    script: "tests/e2e/accessibility-studio-matrix.mjs",
    proof: [ENGINES, ...AAA_RULES, '["site","people","email","totals","add","forms","funnels","deals","reviews","checkup","team"]', "[320,1280]", "Thirteen authenticated read-only studio screens"],
  },
  {
    name: "Products",
    what: "Adding a product, reloading it, hiding and showing it again, and seeing it on the store, in Chromium, Firefox and WebKit, with a test store only.",
    workflow: ".github/workflows/accessibility-product-actions.yml",
    script: "tests/e2e/accessibility-product-actions.mjs",
    proof: [ENGINES, ...AAA_RULES, "Product form and actual disposable local creation/reload/manual visibility/storefront proof only"],
  },
  {
    name: "Buying",
    what: "Paying at a store's checkout against a test payment service, then the receipt email, the buyer's library and the list of orders, in Chromium, Firefox and WebKit.",
    workflow: ".github/workflows/accessibility-buyer-actions.yml",
    script: "tests/e2e/accessibility-buyer-actions.mjs",
    proof: [ENGINES, '"color-contrast-enhanced"', "Real local app checkout against fake Stripe paid return; local captured inbox/library/orders"],
  },
  {
    name: "A real screen reader",
    what: "A short trial with NVDA on Windows and VoiceOver on a Mac: it opens the sign-up and log-in pages and checks what the screen reader says for their main heading.",
    workflow: ".github/workflows/accessibility-real-readers.yml",
    script: "tooling/screen-reader/entry-pilot.mjs",
    proof: ["os: [windows-latest, macos-latest]", 'process.platform==="win32"?"nvda":process.platform==="darwin"?"voiceover"', '{path:"/signin",heading:"Start your store"}', '{path:"/signin?to=login",heading:"Log in to your store"}'],
  },
];

type Gap = { area: string; status: string; publicWording: string };
type Inventory = { openWork: Gap[]; pageTemplates: { status: string; routeTemplate: string }[] };

/** Every open item the inventory records, in the plain words it keeps for this page. */
export function accessibilityGaps(): { area: string; words: string }[] {
  return (inventory as Inventory).openWork.map((item) => ({ area: item.area, words: item.publicWording }));
}

/** The only page-template status that counts as a finished AAA review. */
export const REVIEWED_STATUS = "AAA review completed";

/** How many page templates the inventory lists, and how many it records as fully reviewed for the enhanced level. */
export function reviewCounts(): { total: number; reviewed: number } {
  const templates = (inventory as Inventory).pageTemplates;
  return { total: templates.length, reviewed: templates.filter((t) => t.status === REVIEWED_STATUS).length };
}

const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * A fingerprint of each record the page takes, one a record: each page template's status ("page:" and its route),
 * each open item ("open:" and its area) and each check ("check:" and its name). When one changes, its own review line
 * in lib/accessibility-statement-reviews.ts must change too (DA1 (b)); a change to another record never touches it, so
 * two changes to different records never edit the same line (Proposal 2, BROADCAST-282).
 */
export function statementParts(): Record<string, string> {
  const { openWork, pageTemplates } = inventory as Inventory;
  const parts: Record<string, string> = {};
  for (const template of pageTemplates) parts[`page:${template.routeTemplate}`] = fingerprint({ status: template.status });
  for (const item of openWork) parts[`open:${item.area}`] = fingerprint(item);
  for (const check of ACCESSIBILITY_CHECKS) parts[`check:${check.name}`] = fingerprint(check);
  return parts;
}

export { STATEMENT_REVIEWS };

/**
 * The page's "last updated" date: the latest of its review lines. tests/accessibility-statement.test.ts fails when a
 * record changes and its line is not reviewed again (DA1 (b)).
 */
export const STATEMENT_REVIEW = {
  date: Object.values(STATEMENT_REVIEWS).map((line) => line.date).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? "",
} as const;
