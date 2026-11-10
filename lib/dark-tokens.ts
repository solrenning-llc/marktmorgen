/**
 * The dark color tokens of the Marktmorgen site, studio and buyer area: stage 1 of dark mode (complement WG (a) of
 * 274 [AX1], 10 November 2026). They apply only under `:root[data-color-scheme="dark"]` (app/globals.css), which
 * only a reader's own choice sets: stage 2 added the switch ("Light", "Dark", "Match my device",
 * components/color-scheme-switch.tsx) and the script that applies it before the first paint (lib/color-scheme.ts),
 * and limits them to the pages proved AAA (DARK_READY below). Nobody who has not chosen sees any change. Stage 3
 * replaces the fixed light colors in the other pages (bg-white, text-black, #fff) with tokens and widens the proof.
 * Creators' stores keep their own themes (lib/store-look.ts) and are not touched by any stage.
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


/**
 * The pages the dark tokens are proved on. tests/dark-scheme-switch.test.ts reads every color pair these pages, their
 * layouts and their components draw and holds each to AAA with the tokens on. A page is covered when it carries one
 * of these marks: `.legal-body`, drawn only by the policy pages' frame (components/legal-page.tsx, stage 2), or
 * `data-dark-ready` on a page's own outer element, added screen by screen in stage 3 once that screen is off its
 * fixed light colors; the test finds every page with either mark and proves it. Every other page stays light even
 * when the reader chose dark. A browser that cannot read :has() keeps every page light.
 */
export const DARK_READY = [".legal-body", "[data-dark-ready]"] as const;
export const DARK_SELECTOR = `:root[data-color-scheme="dark"]:has(${DARK_READY.join(", ")})`;

/**
 * The light palette's own tokens, given their dark role on the covered pages. The light indigo is both a link's color
 * and a button's fill; in the dark those are two tokens (above), so each light name takes the role it mostly plays:
 * --violet-deep and --violet-ink are text (links, eyebrows, icons), --violet is a fill (a button, a toast).
 */
export const LEGACY_TOKENS: Record<string, DarkToken> = {
  "violet-deep": "link",
  "violet-ink": "link",
  violet: "action-bg",
  // Stage 3: the roles that were a fixed white in the light palette (app/globals.css :root).
  surface: "sand-deep",
};

/**
 * The rules a covered page needs besides its tokens: a fixed light color (#fff, text-black) or a light name used in
 * its other role. Each is one class (and state) of app/globals.css or one Tailwind utility, written under
 * `:where(DARK_SELECTOR)` so it weighs exactly what the rule it replaces weighs: it wins by coming later (and, over a
 * Tailwind utility, by being outside its layer), while a :hover or :focus of the same class still wins over it.
 */
export const DARK_OVERRIDE_PREFIX = `:where(${DARK_SELECTOR}) `;
export const DARK_OVERRIDES: readonly { selector: string; set: Record<string, string> }[] = [
  // Fixed light utilities.
  { selector: ".text-black", set: { color: "var(--ink)" } },
  { selector: ".bg-white", set: { "background-color": "var(--sand)" } },
  { selector: String.raw`.bg-white\/92`, set: { "background-color": "color-mix(in srgb, var(--paper) 92%, transparent)" } },
  { selector: String.raw`.focus\:bg-white:focus`, set: { "background-color": "var(--sand-deep)" } },
  { selector: ".bg-ink", set: { "background-color": "var(--sand-deep)" } },
  // Red text is error copy: its own token, not the red of a mark.
  { selector: ".text-danger", set: { color: "var(--danger-text)" } },
  // Boxes drawn on white: a raised surface instead.
  { selector: ".card-flat", set: { background: "var(--sand)" } },
  { selector: ".notice", set: { background: "var(--sand)" } },
  { selector: ".chip", set: { background: "var(--sand-deep)" } },
  { selector: ".field", set: { background: "var(--sand-deep)", "border-color": "var(--line-off)" } },
  { selector: ".btn-light", set: { "background-color": "var(--sand-deep)" } },
  // Coming later in the sheet at the same weight, the overrides above would win over a variant's own fill, so each
  // variant says its fill again. A state (:hover, :focus) weighs more and keeps its own.
  { selector: ".chip-brand", set: { background: "var(--lilac)" } },
  { selector: ".chip-dark", set: { background: "var(--fill-dark)" } },
  { selector: ".notice-success", set: { background: "var(--mint-soft)" } },
  { selector: ".notice-warn", set: { background: "var(--amber-soft)" } },
  { selector: ".notice-error", set: { background: "var(--danger-soft)" } },
  { selector: ".notice-info", set: { background: "var(--lilac)" } },
  // White labels on the indigo or the red, which turn light: the dark label instead.
  { selector: ".btn-danger-solid", set: { color: "var(--action-on)" } },
  { selector: ".btn-danger-solid:hover", set: { "background-color": "var(--danger-text)" } },
  { selector: ".nb-toast", set: { color: "var(--action-on)" } },
  { selector: ".nb-toast-close", set: { color: "var(--action-on)" } },
  // Selected text on a dark band keeps the band's white.
  { selector: ".on-dark ::selection", set: { color: "var(--on-dark)", background: "rgba(255, 255, 255, 0.2)" } },
];

export const DARK_BLOCK_START = "/* 274 [AX1] dark mode: dark tokens (lib/dark-tokens.ts). */";
export const DARK_BLOCK_END = "/* end dark tokens */";

/** The CSS block app/globals.css carries, exactly. */
export function darkTokensCss(): string {
  const lines = Object.entries(DARK_TOKENS).map(([name, hex]) => `  --${name}: ${hex};`);
  return [
    DARK_BLOCK_START,
    "/* Only for a reader who chose dark (lib/color-scheme.ts), only on the pages DARK_READY names. Generated: edit the module. */",
    `${DARK_SELECTOR} {`,
    "  color-scheme: dark;",
    ...lines,
    ...Object.entries(LEGACY_TOKENS).map(([name, token]) => `  --${name}: var(--${token});`),
    "  --background: var(--paper);",
    "  --foreground: var(--ink);",
    "}",
    ...DARK_OVERRIDES.map((o) => `${DARK_OVERRIDE_PREFIX}${o.selector} { ${Object.entries(o.set).map(([k, v]) => `${k}: ${v};`).join(" ")} }`),
    DARK_BLOCK_END,
  ].join("\n");
}
