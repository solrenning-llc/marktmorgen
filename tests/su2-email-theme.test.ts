/**
 * 369 [SU2]: a store's emails wear the store's own look — its name at the
 * top, its theme's colors, its color and its letters — with nothing new to
 * set up, while every word in them keeps 7:1 (AX274, WCAG 1.4.6). A color
 * that cannot reach 7:1 is moved only in the email, to the nearest shade that
 * does, and the studio says which one; the store page never changes.
 *
 * The contrast is measured on the HTML the reader receives, walking it tag by
 * tag, with a luminance written here rather than the production helper, so
 * the check cannot agree with the code by sharing its mistake.
 */
import { readFileSync } from "node:fs";
import { render } from "@/lib/mail";
import * as emailThemeModule from "@/lib/email-theme";
import { emailColourNotes, emailColourNotice, emailTheme } from "@/lib/email-theme";
import { COST_LINES } from "./plan-cost-registry";
import { FONTS, THEMES, lookColours, type FontId, type StoreLook, type ThemeId } from "@/lib/store-look";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const VOID = new Set(["img", "hr", "meta", "br", "input", "link"]);
function prop(style: string, name: string): string | undefined {
  return style.match(new RegExp(`(?:^|;)\\s*${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1]?.toLowerCase();
}
type Frame = { tag: string; color?: string; bg?: string };
type Walk = { texts: { text: string; color?: string; bg?: string }[]; edges: { fill: string; on?: string }[]; links: string[] };

/** Every piece of text in the email with the color it is drawn in and the background behind it. */
function walk(html: string): Walk {
  const out: Walk = { texts: [], edges: [], links: [] };
  const stack: Frame[] = [];
  const last = (key: "color" | "bg") => [...stack].reverse().find((frame) => frame[key])?.[key];
  for (const m of html.matchAll(/<(\/?)([a-z0-9!]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const text = m[4].trim();
      // Merge with main (#3030): main gave the email a <title> (the subject) in <head>. Nothing in <head> is drawn
      // on the page, so its words have no color or background to measure; only the body's text is checked.
      if (stack.some((frame) => frame.tag === "head")) continue;
      if (text) out.texts.push({ text, color: last("color"), bg: last("bg") });
      continue;
    }
    const tag = m[2].toLowerCase();
    if (tag.startsWith("!")) continue;
    if (m[1]) {
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (VOID.has(tag)) continue;
    const style = m[3].match(/style="([^"]*)"/)?.[1] ?? "";
    const frame: Frame = { tag, color: prop(style, "color"), bg: prop(style, "background(?:-color)?") };
    if (tag === "a") {
      if (frame.bg) out.edges.push({ fill: frame.bg, on: last("bg") });
      else out.links.push(m[3]);
    }
    stack.push(frame);
  }
  return out;
}

/** The links in the creator's words (the foot's own links are its small, muted words). */
const bodyLinks = (html: string) => walk(html).links.filter((attrs) => /\bhref="https:\/\/example\.com\//.test(attrs));

const BODY =
  "# Fresh this week\n\nA new sourdough guide is out. Read it at https://example.com/guide today.\n\n- Rye\n- Spelt\n\n[Read the guide](https://example.com/guide)\n\n---\n\nSee you soon.";
const PHOTO = "0123456789abcdef0123456789abcdef";

function storeWith(look: Partial<StoreLook>, photoId: string | null = null): Store {
  return {
    handle: "bakery",
    name: "Oven Notes",
    language: "en",
    photoId,
    look: { theme: "light", accent: "#5a36ee", badge: true, sold: false, font: "modern", backdrop: "plain", ...look },
    mail: { fromName: "Oven Notes", address: "1 Main St, Springfield" },
  } as unknown as Store;
}

const ACCENTS = ["#5a36ee", "#ffdd00", "#ffffff", "#000000", "#15112e", "#0e7c86", "#e5533d", "#777777", "#bdb8dc"];
const fonts = FONTS.map((f) => f.id as FontId);

part("Every word in the email, on every theme, color and set of letters, reads at 7:1");
const unreadable: string[] = [];
const faint: string[] = [];
const bareLinks: string[] = [];
let renders = 0;
for (const theme of THEMES.map((t) => t.id as ThemeId)) {
  ACCENTS.forEach((accent, i) => {
    const store = storeWith({ theme, accent, font: fonts[i % fonts.length] }, i % 2 ? PHOTO : null);
    const { html } = render(store, "New loaf", BODY, "tok");
    renders += 1;
    const seen = walk(html);
    for (const t of seen.texts) {
      if (!t.color || !t.bg || ratio(t.color, t.bg) < 7) unreadable.push(`${theme} ${accent}: "${t.text.slice(0, 30)}" ${t.color} on ${t.bg}`);
    }
    for (const e of seen.edges) {
      if (!e.on || ratio(e.fill, e.on) < 3) faint.push(`${theme} ${accent}: button ${e.fill} on ${e.on}`);
    }
    for (const l of seen.links) if (!/text-decoration:underline/.test(l)) bareLinks.push(`${theme} ${accent}: ${l}`);
  });
}
is("emails rendered", renders, THEMES.length * ACCENTS.length);
is("no text below 7:1, and none without an explicit color and background", unreadable, []);
is("every button keeps a 3:1 edge on what is behind it", faint, []);
is("every link that is not a button is underlined, so color is never the only sign", bareLinks, []);

part("The email wears the store's own look");
for (const theme of THEMES.map((t) => t.id as ThemeId)) {
  const look = { theme, accent: "#15112e" } as StoreLook;
  const { html } = render(storeWith(look), "New loaf", BODY, "tok");
  const site = lookColours(look);
  is(`${theme}: the page behind the email is the theme's own background`, html.toLowerCase().includes(`background:${site.bg}`), true);
  is(`${theme}: the card is the theme's own card`, html.toLowerCase().includes(`background:${site.card}`), true);
  is(`${theme}: the words are the theme's own ink`, html.toLowerCase().includes(`color:${site.text}`), true);
  is(`${theme}: the button is the store page's own button`, html.toLowerCase().includes(`background:${site.accent}`), true);
  is(`${theme}: the email tells mail apps whether it is light or dark`, html.includes(`<meta name="color-scheme" content="${site.dark ? "dark" : "light"}">`), true);
}
{
  const { html } = render(storeWith({ accent: "#15112e" }), "New loaf", BODY, "tok");
  is("a store color that already reads at 7:1 is used on links as it is", bodyLinks(html).length > 0 && bodyLinks(html).every((s) => /color:#15112e/i.test(s)), true);
}
{
  const theme = emailTheme(storeWith({ font: "editorial" }).look, { name: "Oven Notes" });
  const { html } = render(storeWith({ font: "editorial" }), "New loaf", BODY, "tok");
  is("Editorial headings ask for the store's serif, then a serif every mail app has", /<h2 [^>]*font-family:Fraunces,Georgia/.test(html), true);
  is("the theme names the same heading letters", theme.headFont.startsWith("Fraunces,Georgia"), true);
}
for (const font of fonts) {
  const { html } = render(storeWith({ font }), "New loaf", BODY, "tok");
  const families = [...html.matchAll(/font-family:([^;"]+)/g)].map((m) => m[1]);
  is(`${font}: every font list ends in a family every mail app has`, families.length > 0 && families.every((f) => /(?:sans-serif|serif)$/.test(f.trim())), true);
  is(`${font}: no font is downloaded from anywhere`, /@import|<link|url\(|fonts\.googleapis|fonts\.gstatic/i.test(html), false);
}

part("No picture at the top: the store's name in words, until an email-size copy of the photo exists (Claude 1's re-review of #3030, comment 6709534250, MEDIUM money)");
{
  // The store photo is 480 px and up to MAX_PHOTO_BYTES; drawn at 48 px in every email, each reader's fetch of it,
  // priced at the dearest region, passes the owner's US$65 refunded first year (tests/email-logo-region.test.ts). So
  // the header draws no picture of this site, with or without a photo, and no cost line prices one.
  const withPhoto = render(storeWith({}, PHOTO), "New loaf", BODY, "tok").html;
  const plain = render(storeWith({}, null), "New loaf", BODY, "tok").html;
  for (const theme of THEMES.map((t) => t.id as ThemeId)) {
    const html = render(storeWith({ theme }, PHOTO), "New loaf", BODY, "tok").html;
    is(`${theme}: an email of a store with a photo draws no picture at all (the body here has none)`, /<img\b/i.test(html) || html.includes("/api/photo/"), false);
  }
  is("with a photo, the store's name is written at the top, once", walk(withPhoto).texts.filter((t) => t.text === "Oven Notes").length, 1);
  is("without a photo, the same", walk(plain).texts.filter((t) => t.text === "Oven Notes").length, 1);
  is("the photo changes nothing in the email", withPhoto, plain);
  is("the theme carries no logo", "logo" in emailTheme(storeWith({}, PHOTO).look, { name: "Oven Notes" }), false);
  is("no cost line prices a logo that is not sent", COST_LINES.some((l) => l.id === "email-logo"), false);
  is("the reads of a logo that is not sent are not exported", "EMAIL_LOGO_READS" in emailThemeModule, false);
  const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
  is("a trial's worst window prices no logo either", /EMAIL_LOGO/.test(registry), false);
}

part("The text version does not change");
{
  const before =
    "Fresh this week\n\nA new sourdough guide is out. Read it at https://example.com/guide today.\n\n- Rye\n- Spelt\n\nRead the guide: https://example.com/guide\n\n—\n\nSee you soon.\n\n—\nYou are getting this because you told Oven Notes you wanted to hear from them.\nUnsubscribe in one click: https://marktmorgen.com/unsubscribe?t=tok\n\nOven Notes · 1 Main St, Springfield\nSent with Marktmorgen.";
  is("the text version is what it was before the email took the store's look", render(storeWith({ accent: "#ffdd00", font: "editorial" }, PHOTO), "New loaf", BODY, "tok").text, before);
  is("a dark store's text version is the same words", render(storeWith({ theme: "night", accent: "#e5533d" }), "New loaf", BODY, "tok").text, before);
}

part("The store page never changes; only the email is adjusted");
{
  const store = storeWith({ theme: "sand", accent: "#ffdd00", font: "friendly" }, PHOTO);
  const lookBefore = JSON.stringify(store.look);
  const siteBefore = JSON.stringify(lookColours(store.look));
  render(store, "New loaf", BODY, "tok");
  is("the store's saved look is untouched", JSON.stringify(store.look), lookBefore);
  is("the store page's colors are untouched", JSON.stringify(lookColours(store.look)), siteBefore);
}

part("The studio is told which color was adjusted for emails");
{
  const yellow = { theme: "light", accent: "#ffdd00", font: "modern" } as StoreLook;
  const notes = emailColourNotes(yellow);
  const links = notes.find((n) => n.role === "links");
  is("a pale yellow is adjusted on links in the email", Boolean(links && links.picked === "#ffdd00" && links.sent !== "#ffdd00"), true);
  is("the adjusted link color reads at 7:1 on the email's card", links ? ratio(links.sent, lookColours(yellow).card) >= 7 : false, true);
  const { html } = render(storeWith(yellow), "New loaf", BODY, "tok");
  is("the email uses exactly the color the studio names", links ? bodyLinks(html).length > 0 && bodyLinks(html).every((s) => s.toLowerCase().includes(`color:${links.sent}`)) : false, true);
  const notice = emailColourNotice(yellow) ?? "";
  is("the notice names the color picked and the one emails use", notice.includes("#ffdd00") && links !== undefined && notice.includes(links.sent), true);
  is("the notice says it is only in emails and the store page keeps the color", /email/i.test(notice) && /store page/i.test(notice), true);
  // LEVE of the review of #3030 (comment 6697965825): an email's button is the store page's own button, so the
  // notice names only what differs from the store page, the links, and never calls the move "a little".
  const shades: StoreLook[] = [yellow, { theme: "light", accent: "#bdb8dc" } as StoreLook, { theme: "night", accent: "#4c1d95" } as StoreLook, { theme: "bold", accent: "#ffdd00" } as StoreLook];
  is("no note claims the email's buttons differ, since they are the store page's own", shades.flatMap((look) => emailColourNotes(look).filter((n) => n.role !== "links").map((n) => `${look.theme} ${look.accent}: ${n.role}`)), []);
  is("no notice speaks of buttons as changed or says \"a little\"", shades.map((look) => emailColourNotice(look) ?? "").filter((text) => /\bbuttons?\b|a little/i.test(text) && !/buttons? (?:use|are) the same/i.test(text)), []);
  is("a color that already reads needs no notice", [emailColourNotes({ theme: "light", accent: "#15112e" } as StoreLook), emailColourNotice({ theme: "light", accent: "#15112e" } as StoreLook)], [[], null]);
  const night = emailColourNotes({ theme: "night", accent: "#5a36ee" } as StoreLook);
  is("on Night, a dark color is lightened on links rather than darkened", night.some((n) => n.role === "links" && n.direction === "lighter"), true);
  const editor = readFileSync("components/look-editor.tsx", "utf8");
  is("the studio's look editor shows the notice", editor.includes("emailColourNotice("), true);
}

done();
