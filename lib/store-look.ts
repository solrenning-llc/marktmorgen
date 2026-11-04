/**
 * How a creator's public page looks: a theme and one colour.
 *
 * The creator picks the colour freely, including one of their own, and the
 * page still has to be readable by everyone who opens it. So the colour they
 * pick is the starting point rather than the final value: every colour the
 * page actually paints is derived here and moved, only as far as needed,
 * until it passes the contrast a reader needs — 7:1 for button text, 4.5:1
 * for other accent text and 3:1 for
 * the edge of a button. A pale yellow still reads as yellow; it simply stops
 * being a button nobody can see.
 *
 * Nothing in this file touches the network or the store, so the studio can
 * run the same arithmetic in the browser for its live preview and the two can
 * never disagree about what the page will look like.
 */

export const THEMES = [
  {
    id: "light",
    label: "Paper",
    description: "Light and quiet. Your color is on the buttons.",
  },
  {
    id: "sand",
    label: "Sand",
    description: "Warm and soft, like good paper in the sun.",
  },
  {
    id: "night",
    label: "Night",
    description: "Dark, for photos and colors that glow.",
  },
  {
    id: "bold",
    label: "Color",
    description: "Your color across the top of the page.",
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/**
 * The letters of the page (added 9 October 2026): one of five pairings of a
 * face for headings with one for reading. Kajabi, Hotmart and Stan all let a
 * creator choose type; this page only had one. Every face is served from our
 * own address (app/layout.tsx, next/font), never preloaded, so a page only
 * downloads the one its creator picked and a page left on Modern downloads
 * nothing more than it did. `head` and `body` name the CSS variables
 * app/layout.tsx defines; an empty one keeps the site's own face.
 */
export const FONTS = [
  { id: "modern", label: "Modern", description: "Clean and plain, easy to read on any screen.", head: "", body: "", tracking: "" },
  { id: "editorial", label: "Editorial", description: "A warm serif for headings, like a good magazine.", head: "--font-st-editorial", body: "", tracking: "-0.015em" },
  { id: "elegant", label: "Elegant", description: "A fine, high-contrast serif for headings.", head: "--font-st-elegant", body: "", tracking: "-0.01em" },
  { id: "friendly", label: "Friendly", description: "Rounded letters everywhere, soft and welcoming.", head: "--font-st-friendly", body: "--font-st-friendly", tracking: "-0.015em" },
  { id: "bold", label: "Bold", description: "Wide, confident headings that stand out.", head: "--font-st-bold", body: "", tracking: "-0.03em" },
] as const;

export type FontId = (typeof FONTS)[number]["id"];

/**
 * What lies behind the cards (added 9 October 2026): plain, or a soft glow
 * of the store's color, fine dots, a light grid, or a slow aurora that only
 * moves for visitors who have not asked their device for less motion.
 * Linktree and Beacons let a creator pick a background; every one here is
 * drawn by the page itself in its own colors, so nothing is downloaded and
 * the words keep their contrast.
 */
export const BACKDROPS = [
  { id: "plain", label: "Plain", description: "Just the theme's color." },
  { id: "glow", label: "Glow", description: "A soft light of your color at the top." },
  { id: "dots", label: "Dots", description: "Fine dots, like good notebook paper." },
  { id: "grid", label: "Grid", description: "A light grid, neat and technical." },
  { id: "aurora", label: "Aurora", description: "Your color drifting slowly behind everything." },
] as const;

export type BackdropId = (typeof BACKDROPS)[number]["id"];

export function isBackdrop(value: unknown): value is BackdropId {
  return typeof value === "string" && BACKDROPS.some((b) => b.id === value);
}

/** The class that draws a store's backdrop on its pages ("" for plain). */
export function backdropClass(look: Pick<StoreLook, "backdrop">): string {
  return look.backdrop && look.backdrop !== "plain" ? `st-bg-${look.backdrop}` : "";
}

export function isFont(value: unknown): value is FontId {
  return typeof value === "string" && FONTS.some((font) => font.id === value);
}

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));

/** Colours to start from. The creator may also type or pick any other one. */
export const ACCENTS = [
  { hex: "#5a36ee", label: "Violet" },
  { hex: "#2f74f5", label: "Blue" },
  { hex: "#0e7c86", label: "Teal" },
  { hex: "#15803d", label: "Green" },
  { hex: "#b45309", label: "Amber" },
  { hex: "#e5533d", label: "Coral" },
  { hex: "#db2777", label: "Pink" },
  { hex: "#9333ea", label: "Plum" },
  { hex: "#be123c", label: "Ruby" },
  { hex: "#15112e", label: "Ink" },
] as const;

/**
 * `badge` is whether "Made with Marktmorgen" is printed at the foot of the
 * creator's page. It starts true, and only a store on Pro may turn it off —
 * that check is not here, because this file never reads a plan. The page
 * that draws the badge asks canUse(store, "branding") as well, so a store
 * that leaves Pro gets the badge back the same day rather than keeping an
 * entitlement it no longer pays for.
 */
export type StoreLook = {
  theme: ThemeId;
  accent: string;
  badge: boolean;
  /**
   * Whether each product's card and page say how many times it was bought
   * (lib/sold-count.ts). Off unless the creator turns it on: the number is
   * real, read from their own Stripe account, and theirs to show or not.
   */
  sold: boolean;
  /** The letters of the page (FONTS). Modern unless the creator picks another. */
  font: FontId;
  /** What lies behind the cards (BACKDROPS). Plain unless the creator picks another. */
  backdrop: BackdropId;
};

export const DEFAULT_LOOK: StoreLook = { theme: "light", accent: "#5a36ee", badge: true, sold: false, font: "modern", backdrop: "plain" };

/** Exactly six hex digits after a hash, lower case. Nothing else is a colour here. */
export const HEX_PATTERN = /^#[0-9a-f]{6}$/;

export function isTheme(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

/** Reads a typed or picked colour: "#AbC123", "abc123" and "#abc" all count. */
export function normaliseHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim().toLowerCase();
  if (!text.startsWith("#")) text = `#${text}`;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    text = `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return HEX_PATTERN.test(text) ? text : null;
}

/** Whatever came back from storage, made safe to use. */
export function parseLook(raw: unknown): StoreLook {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LOOK };
  const value = raw as Partial<StoreLook>;
  return {
    theme: isTheme(value.theme) ? value.theme : DEFAULT_LOOK.theme,
    accent: normaliseHex(value.accent) ?? DEFAULT_LOOK.accent,
    // Anything that is not an explicit false leaves the badge on, so a store
    // saved before this field existed keeps showing it.
    badge: value.badge !== false,
    // Only an explicit true: every store saved before this existed keeps it off.
    sold: value.sold === true,
    font: isFont(value.font) ? value.font : DEFAULT_LOOK.font,
    backdrop: isBackdrop(value.backdrop) ? value.backdrop : DEFAULT_LOOK.backdrop,
  };
}

type Palette = {
  bg: string;
  card: string;
  item: string;
  text: string;
  muted: string;
  line: string;
  lineStrong: string;
  field: string;
  dark: boolean;
};

const PALETTES: Record<ThemeId, Palette> = {
  light: {
    bg: "#fbfaf7",
    card: "#ffffff",
    item: "#fbfaf7",
    text: "#15112e",
    muted: "#4a4560",
    line: "#e6e1d6",
    lineStrong: "#cbc4b4",
    field: "#ffffff",
    dark: false,
  },
  sand: {
    bg: "#f3ece0",
    card: "#fffdf9",
    item: "#f8f3ea",
    text: "#2a2118",
    // 7.98:1 on the page, 9.22:1 on a card, 8.48:1 on an item: muted words are small text, so AAA asks 7:1 (was #5c5244, 6.51:1).
    muted: "#4f4538",
    line: "#e4d9c6",
    lineStrong: "#c9bba2",
    field: "#fffdf9",
    dark: false,
  },
  night: {
    bg: "#0d0b24",
    card: "#16133a",
    item: "#1d1946",
    text: "#f5f3ff",
    muted: "#bdb8dc",
    line: "#2e2a66",
    lineStrong: "#4d4893",
    field: "#100e2c",
    dark: true,
  },
  bold: {
    bg: "#fbfaf7",
    card: "#ffffff",
    item: "#fbfaf7",
    text: "#15112e",
    muted: "#4a4560",
    line: "#e6e1d6",
    lineStrong: "#cbc4b4",
    field: "#ffffff",
    dark: false,
  },
};

const WHITE = "#ffffff";
const BLACK = "#000000";

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(values: number[]): string {
  return `#${values
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour a share of the way from one to another. */
export function mix(from: string, to: string, share: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex(a.map((v, i) => v + (b[i] - v) * share));
}

/**
 * The first colour on the way from `color` to `target` that passes `test`,
 * in small steps, so a colour is moved no further than it has to be.
 */
function nearestPassing(color: string, target: string, test: (c: string) => boolean): string {
  for (let step = 0; step <= 25; step += 1) {
    const candidate = mix(color, target, step / 25);
    if (test(candidate)) return candidate;
  }
  return target;
}

export type LookColours = {
  bg: string;
  card: string;
  item: string;
  text: string;
  muted: string;
  line: string;
  lineStrong: string;
  field: string;
  /** The fill of the buttons: the creator's colour, moved until it can be seen. */
  accent: string;
  /** The words on that fill. */
  onAccent: string;
  /** The creator's colour where it is used as text or as a thin line. */
  accentText: string;
  /** A wash of the colour behind the option a buyer has picked. */
  accentSoft: string;
  /** The far end of the band across the top of the Colour theme. */
  accent2: string;
  /**
   * The wash behind every other section of a sales page set in bands
   * (lib/sales-page.ts, PageStyle): the creator's colour, faint, and moved
   * towards the card until the text, the muted text and the coloured links
   * on it all still read.
   */
  band: string;
  dark: boolean;
};

/**
 * Every colour the page paints, worked out from the two things the creator
 * chose. It takes only those two rather than a whole StoreLook, because the
 * badge has nothing to do with colour and several callers — an Open Graph
 * image, the studio's live preview — have a theme and an accent in hand and
 * no store behind them.
 */
export type LookPaint = Pick<StoreLook, "theme" | "accent"> & { font?: FontId; backdrop?: BackdropId };

export function lookColours(look: LookPaint): LookColours {
  const palette = PALETTES[look.theme] ?? PALETTES.light;
  const picked = normaliseHex(look.accent) ?? DEFAULT_LOOK.accent;
  const away = palette.dark ? WHITE : BLACK;

  // Keep the button edge and its words readable together. Choosing dark ink
  // on a light card can make those constraints incompatible: use white on
  // light themes and the page's dark ink on Night, then move only the fill.
  const onAccent = palette.dark ? "#0d0b24" : WHITE;
  const fill = nearestPassing(
    picked,
    away,
    (c) => contrast(c, palette.card) >= 3 && contrast(c, onAccent) >= 7,
  );

  const accentText = nearestPassing(
    picked,
    palette.text,
    (c) => contrast(c, palette.card) >= 4.5 && contrast(c, palette.item) >= 4.5,
  );

  const accentSoft = nearestPassing(
    mix(fill, palette.card, palette.dark ? 0.72 : 0.86),
    palette.card,
    // Muted words sit on it too (a chosen or highlighted thing's note): 7:1, which the card always reaches.
    (c) => contrast(c, palette.text) >= 7 && contrast(c, palette.muted) >= 7,
  );

  const band = nearestPassing(
    mix(fill, palette.card, palette.dark ? 0.78 : 0.87),
    palette.card,
    // Muted words on a band are small text too: 7:1, which the card always reaches, so a band only grows paler to pass.
    (c) => contrast(c, palette.text) >= 7 && contrast(c, palette.muted) >= 7 && contrast(c, accentText) >= 4.5,
  );

  // The band behind the name on the Colour theme runs from the fill to a
  // shade of it. The shade moves in the direction that helps the words on it.
  const accent2 = onAccent === WHITE ? mix(fill, BLACK, 0.3) : mix(fill, WHITE, 0.35);

  return {
    bg: palette.bg,
    card: palette.card,
    item: palette.item,
    text: palette.text,
    muted: palette.muted,
    line: palette.line,
    lineStrong: palette.lineStrong,
    field: palette.field,
    accent: fill,
    onAccent,
    accentText,
    accentSoft,
    accent2,
    band,
    dark: palette.dark,
  };
}

/** The same colours as CSS custom properties, for the page's outermost element. */
export function lookStyle(look: LookPaint): Record<string, string> {
  const c = lookColours(look);
  return {
    "--st-bg": c.bg,
    "--st-card": c.card,
    "--st-item": c.item,
    "--st-text": c.text,
    "--st-muted": c.muted,
    "--st-line": c.line,
    "--st-line-strong": c.lineStrong,
    "--st-field": c.field,
    "--st-accent": c.accent,
    "--st-on-accent": c.onAccent,
    "--st-accent-text": c.accentText,
    "--st-accent-soft": c.accentSoft,
    "--st-accent-2": c.accent2,
    "--st-band": c.band,
    ...fontStyle(look.font),
    ...backdropStyle(look.backdrop),
    colorScheme: c.dark ? "dark" : "light",
  };
}

/**
 * The variables that draw a page's backdrop (app/globals.css, .st-page):
 * none for Plain. Every one is painted from the page's own colors at a low
 * strength, so text set on the page keeps its contrast.
 */
export function backdropStyle(id: BackdropId | undefined): Record<string, string> {
  const tint = (percent: number, of = "var(--st-accent)") => `color-mix(in srgb, ${of} ${percent}%, transparent)`;
  switch (id) {
    case "glow":
      return {
        "--st-backdrop": `radial-gradient(60rem 26rem at 12% -6rem, ${tint(22)}, transparent 70%), radial-gradient(48rem 24rem at 100% 0, ${tint(14)}, transparent 70%)`,
      };
    case "dots":
      return { "--st-backdrop": `radial-gradient(${tint(10, "var(--st-text)")} 1px, transparent 1.5px)`, "--st-backdrop-size": "18px 18px" };
    case "grid":
      return {
        "--st-backdrop": `linear-gradient(${tint(6, "var(--st-text)")} 1px, transparent 1px), linear-gradient(90deg, ${tint(6, "var(--st-text)")} 1px, transparent 1px)`,
        "--st-backdrop-size": "28px 28px",
      };
    case "aurora":
      return {
        "--st-backdrop": `radial-gradient(40rem 24rem at 20% 10%, ${tint(16)}, transparent 70%), radial-gradient(36rem 22rem at 80% 30%, ${tint(12, "var(--st-accent-2)")}, transparent 70%), radial-gradient(44rem 26rem at 50% 90%, ${tint(10)}, transparent 70%)`,
        "--st-backdrop-size": "200% 200%",
        "--st-backdrop-play": "running",
      };
    default:
      return {};
  }
}

/** The variables that set a page's letters (app/globals.css, .st-page); none for Modern. */
export function fontStyle(id: FontId | undefined): Record<string, string> {
  const font = FONTS.find((f) => f.id === id);
  if (!font || font.id === "modern") return {};
  const out: Record<string, string> = {};
  if (font.head) out["--st-font-head"] = `var(${font.head})`;
  if (font.body) out["--st-font-body"] = `var(${font.body})`;
  if (font.tracking) out["--st-head-tracking"] = font.tracking;
  return out;
}

/** A name for a colour that is not one of the presets, for screen readers. */
export function accentLabel(hex: string): string {
  return ACCENTS.find((accent) => accent.hex === hex)?.label ?? `Your color, ${hex}`;
}
