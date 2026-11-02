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
    what: "Two studio pages, the studio's front page and its list of pages, viewed only (nothing is saved), in Chromium, Firefox and WebKit.",
    workflow: ".github/workflows/accessibility-studio-matrix.yml",
    script: "tests/e2e/accessibility-studio-matrix.mjs",
    proof: [ENGINES, ...AAA_RULES, "Two authenticated read-only studio/editor surfaces only"],
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
type Inventory = { openWork: Gap[]; pageTemplates: { status: string }[] };

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

/** A fingerprint of everything the page takes from the records; when it changes, the review date must change too. */
export function statementDigest(): string {
  const { openWork, pageTemplates } = inventory as Inventory;
  const basis = JSON.stringify({ openWork, statuses: pageTemplates.map((t) => t.status), checks: ACCESSIBILITY_CHECKS });
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/**
 * The page's "last updated" date and the records it was reviewed against.
 * tests/accessibility-statement.test.ts fails when the records change and this
 * is not reviewed again (DA1 (b)).
 */
export const STATEMENT_REVIEW = { date: "November 1, 2026", digest: "ca6c480bae65776d" } as const;
