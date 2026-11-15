/**
 * The dark color tokens of the Marktmorgen site, studio and buyer area: stage 1 of dark mode (complement WG (a) of
 * 274 [AX1], 10 November 2026). DORMANT: they apply only under `:root[data-color-scheme="dark"]` (app/globals.css),
 * and nothing sets that attribute yet, so no page looks any different today. Stage 2 adds the switch ("Light",
 * "Dark", "Match my device") and the script that sets the attribute before the first paint; stage 3 replaces the
 * fixed light colors in the pages (bg-white, text-black, #fff) with tokens. Creators' stores keep their own themes
 * (lib/store-look.ts) and are not touched by any stage.
 *
 * Every pair a token is used in is listed below with its role, and tests/dark-tokens.test.ts holds each to the AAA
 * threshold of its role (WCAG 2.2): 7:1 for text (1.4.6), 4.5:1 for large text (1.4.6), 3:1 for the edges of
 * controls, focus rings and meaningful graphics (1.4.11). It also holds the CSS block in app/globals.css to these
 * exact values, so the two never drift apart.
 *
 * The light palette uses one indigo (--violet) both as a button's background and as a link's color. In the dark no
 * single color can be both: a link must be light to read on a dark page, and a button's label must read on the
 * button. So the dark palette splits the roles: --action-bg (a button's fill), --action-on (its label),
 * --action-border (its edge) and --link (link text), plus --focus-ring. Stage 3 moves the pages to these roles.
 *
 * Pure: no IO. Browser-safe.
 */

/** Hex colors, `#rrggbb`, by token name without the leading `--`. */
export const DARK_TOKENS = {
  // Surfaces: the page, a band one step up, a raised box.
  paper: "#10151d",
  sand: "#161c26",
  "sand-deep": "#1e2531",
  // Lines that only separate (decorative, no contrast duty) and the dashed edge of an off control (a UI boundary).
  line: "#2a3240",
  "line-strong": "#3b4453",
  "line-off": "#7d8797",
  // Text, in three steps.
  ink: "#f4f2ed",
  "ink-soft": "#dad7d0",
  "ink-mute": "#c9c5bc",
  // The tinted surfaces of the accent.
  lilac: "#1d1f3a",
  "lilac-deep": "#262a4d",
  // The accent, split by role.
  "action-bg": "#b9b7f5",
  "action-on": "#10151d",
  "action-border": "#b9b7f5",
  link: "#c3c1f7",
  "focus-ring": "#c3c1f7",
  "accent-large": "#9a97e0",
  // Semantic: green for money and success, red for errors, amber for a warning.
  "mint-soft": "#0f2a22",
  "mint-text": "#8fe8c6",
  mint: "#4fd1a3",
  "danger-soft": "#331614",
  "danger-text": "#ffb4ab",
  danger: "#ff7b6e",
  "amber-soft": "#2e2210",
  amber: "#ffcf8a",
} as const;

export type DarkToken = keyof typeof DARK_TOKENS;

/** What a pair is, and so the AAA threshold it is held to. */
export type PairRole = "text" | "large-text" | "ui";
export const ROLE_MINIMUM: Record<PairRole, number> = { text: 7, "large-text": 4.5, ui: 3 };

export type DarkPair = { fg: DarkToken; bg: DarkToken; role: PairRole; what: string };

const TEXT_SURFACES: DarkToken[] = ["paper", "sand", "sand-deep", "lilac", "lilac-deep"];
const PLAIN_SURFACES: DarkToken[] = ["paper", "sand", "sand-deep"];

/** Every pair a dark token is drawn in. A token in no pair is a token nobody has proved, and the test refuses it. */
export const DARK_PAIRS: readonly DarkPair[] = [
  ...(["ink", "ink-soft", "ink-mute"] as const).flatMap((fg) => TEXT_SURFACES.map((bg): DarkPair => ({ fg, bg, role: "text", what: `${fg} text` }))),
  ...TEXT_SURFACES.map((bg): DarkPair => ({ fg: "link", bg, role: "text", what: "a link" })),
  { fg: "action-on", bg: "action-bg", role: "text", what: "a button's label on the button" },
  { fg: "mint-text", bg: "mint-soft", role: "text", what: "success copy on its band" },
  { fg: "mint-text", bg: "paper", role: "text", what: "success copy on the page" },
  { fg: "danger-text", bg: "danger-soft", role: "text", what: "error copy on its band" },
  { fg: "danger-text", bg: "paper", role: "text", what: "error copy on the page" },
  { fg: "amber", bg: "amber-soft", role: "text", what: "warning copy on its band" },
  { fg: "amber", bg: "paper", role: "text", what: "warning copy on the page" },
  ...PLAIN_SURFACES.map((bg): DarkPair => ({ fg: "accent-large", bg, role: "large-text", what: "an accent heading, large text only" })),
  ...PLAIN_SURFACES.flatMap((bg): DarkPair[] => [
    { fg: "action-border", bg, role: "ui", what: "a button's edge" },
    { fg: "action-bg", bg, role: "ui", what: "a filled button against the page" },
    { fg: "focus-ring", bg, role: "ui", what: "the focus ring" },
    { fg: "line-off", bg, role: "ui", what: "the dashed edge of an off control" },
    { fg: "danger", bg, role: "ui", what: "an error mark" },
    { fg: "mint", bg, role: "ui", what: "a success mark" },
  ]),
];

/** Tokens that only separate areas and carry no meaning, so WCAG asks no contrast of them. Listed, never silently skipped. */
export const DECORATIVE_TOKENS: readonly DarkToken[] = ["line", "line-strong"];

/** WCAG 2.2 relative luminance of a `#rrggbb` color. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio of two colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const DARK_BLOCK_START = "/* 274 [AX1] dark mode, stage 1: dormant dark tokens (lib/dark-tokens.ts). */";
export const DARK_BLOCK_END = "/* end dark tokens */";

/** The CSS block app/globals.css carries, exactly. */
export function darkTokensCss(): string {
  const lines = Object.entries(DARK_TOKENS).map(([name, hex]) => `  --${name}: ${hex};`);
  return [
    DARK_BLOCK_START,
    "/* Nothing sets data-color-scheme yet, so no page changes. tests/dark-tokens.test.ts holds every pair to AAA. */",
    ':root[data-color-scheme="dark"] {',
    "  color-scheme: dark;",
    ...lines,
    "  --background: var(--paper);",
    "  --foreground: var(--ink);",
    "}",
    DARK_BLOCK_END,
  ].join("\n");
}
