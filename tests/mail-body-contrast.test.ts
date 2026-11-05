import { bodyHtml, bodyText, parseMailBlocks } from "@/lib/mail-body";
import { done, is, part } from "./check";

const button = "[Read the guide](https://example.com/guide)";
function painted(accent: string): { fill: string; ink: string } {
  const html = bodyHtml(button, undefined, accent);
  const fill = html.match(/background:(#[0-9a-f]{6})/i)?.[1];
  const ink = html.match(/;color:(#[0-9a-f]{6})/i)?.[1];
  if (!fill || !ink) throw new Error("Rendered button has no explicit color pair");
  return { fill, ink };
}

// Measure the emitted HTML, independently of the production color helper.
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio({ fill, ink }: { fill: string; ink: string }): number {
  const a = luminance(fill);
  const b = luminance(ink);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

part("Creator email buttons: rendered text contrast");
for (const accent of ["#777777", "#999999", "#00aa00", "#ee7700", "#4c1d95", "#ffdd00", "#ffffff", "#000000"]) {
  is(`${accent} renders button text at least 7:1`, ratio(painted(accent)) >= 7, true);
}

const colors = new Set<string>();
for (let value = 0; value <= 255; value++) colors.add(`#${value.toString(16).padStart(2, "0").repeat(3)}`);
for (const r of [0, 51, 102, 153, 204, 255]) {
  for (const g of [0, 51, 102, 153, 204, 255]) {
    for (const b of [0, 51, 102, 153, 204, 255]) {
      colors.add(`#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
    }
  }
}
const unreadable = [...colors].filter((accent) => ratio(painted(accent)) < 7);
is("all grayscale values and a six-level RGB grid render at least 7:1", unreadable, []);

part("Existing content and safe colors are preserved");
is("dark store color remains unchanged", painted("#4c1d95").fill, "#4c1d95");
is("readable light store color remains unchanged", painted("#ffdd00"), { fill: "#ffdd00", ink: "#1c1917" });
is("invalid CSS falls back to the established accent", painted("red;}body{display:none"), painted("#4c1d95"));
is("uppercase hex remains readable", ratio(painted("#00AA00")) >= 7, true);
let targets = 0;
const html = bodyHtml(button, (href) => { targets++; return `${href}?utm_source=email`; }, "#999999");
is("one tagged destination is kept", [targets, html.includes('href="https://example.com/guide?utm_source=email"')], [1, true]);
is("the creator's label is kept", html.includes(">Read the guide</a>"), true);
is("plain-text content is unchanged", bodyText(button), "Read the guide: https://example.com/guide");
is("creator HTML is still escaped", bodyHtml("[<Guide>](https://example.com)", undefined, "#999999").includes(">&lt;Guide&gt;</a>"), true);
part("Buttons typed in the email editor need a readable name");
for (const label of [" ", "   ", "\t", "\u00a0"]) {
  const input = `[${label}](https://example.com/guide)`;
  const html = bodyHtml(input);
  is(`blank label ${JSON.stringify(label)} stays a text block`, parseMailBlocks(input)[0].kind, "text");
  is(`blank label ${JSON.stringify(label)} has a URL as its link name`, html.includes(">https://example.com/guide</a>"), true);
  is(`blank label ${JSON.stringify(label)} is never an unnamed button`, />\s*<\/a>/.test(html), false);
  is(`blank label ${JSON.stringify(label)} keeps its source in plain text`, bodyText(input), input);
}
is("a real label with surrounding whitespace remains a button", parseMailBlocks("[ Read the guide ](https://example.com/guide)"), [{ kind: "button", label: "Read the guide", href: "https://example.com/guide" }]);
is("a non-Latin label remains a named button", bodyHtml("[読む](https://example.com/guide)").includes(">読む</a>"), true);
done();
