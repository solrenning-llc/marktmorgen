/**
 * The colors of app/global-error.tsx, the page shown when the root layout itself fails. That page renders its own
 * document without app/globals.css, so it carries the site's own tokens as plain values: light from `:root`, dark
 * from the dormant dark block of lib/dark-tokens.ts, which this page never switches on itself (ivory and ink, the
 * violet action and link, the focus ring). Each text pair keeps 7:1 (WCAG 1.4.6) and the ring 3:1
 * (tests/global-error-page.test.ts).
 */
export const GLOBAL_ERROR_LOOK = {
  light: {
    page: "#f7f5f0",
    text: "#111827",
    muted: "#343d4a",
    primary: "#3b3890",
    primaryText: "#ffffff",
    link: "#3b3890",
    focus: "#4946a6",
  },
  dark: {
    page: "#10151d",
    text: "#f4f2ed",
    muted: "#dad7d0",
    primary: "#b9b7f5",
    primaryText: "#10151d",
    link: "#c3c1f7",
    focus: "#c3c1f7",
  },
} as const;

type Look = (typeof GLOBAL_ERROR_LOOK)[keyof typeof GLOBAL_ERROR_LOOK];

const colors = (c: Look) =>
  `body{background:${c.page};color:${c.text}}.ge-muted{color:${c.muted}}.ge-primary{background:${c.primary};color:${c.primaryText};border-color:${c.primary}}.ge-link{color:${c.link};border-color:${c.link}}:focus-visible{outline-color:${c.focus}}`;

/** The page's whole style sheet: its layout, its 44 px targets, its focus ring and both schemes' colors. */
export const GLOBAL_ERROR_STYLE = [
  "html{color-scheme:light dark}",
  "body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5;font-size:1.0625rem}",
  "main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;box-sizing:border-box}",
  ".ge-card{max-width:32rem;width:100%}",
  "h1{font-size:1.75rem;line-height:1.3;margin:0.5rem 0 0}",
  "p{margin:0.75rem 0 0;max-width:65ch}",
  ".ge-steps{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1.75rem}",
  ".ge-action{min-height:44px;min-width:44px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0.625rem 1.25rem;border:2px solid;border-radius:0.75rem;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}",
  ".ge-link{background:transparent;text-decoration:underline;text-underline-offset:4px}",
  ":focus-visible{outline:3px solid;outline-offset:3px}",
  "@media (prefers-reduced-motion: no-preference){.ge-action{transition:none}}",
  colors(GLOBAL_ERROR_LOOK.light),
  `@media (prefers-color-scheme: dark){${colors(GLOBAL_ERROR_LOOK.dark)}}`,
  "@media (forced-colors: active){.ge-action{border-color:ButtonText}:focus-visible{outline-color:Highlight}}",
].join("\n");
