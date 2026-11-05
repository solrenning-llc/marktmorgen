import { bodyHtml, bodyText, parseMailBlocks } from "@/lib/mail-body";
import { done, is } from "./check";

const url = "https://example.com/guide?one=1&two=2";
const blank = [" ", "\t", "\u00a0", "\u202f", "\u2028", "\u2029", "\ufeff", " \t "];
is("all whitespace-only labels expose the original URL instead of an unnamed anchor", blank.every(label => {
  const input = `[${label}](${url})`;
  return parseMailBlocks(input)[0].kind === "text" && bodyHtml(input).includes("https://example.com/guide?one=1&amp;two=2</a>") && !/>\s*<\/a>/.test(bodyHtml(input)) && bodyText(input) === input;
}), true);
is("real labels remain buttons across writing systems", ["読む", "Guía", "دليل", "🧪 Guide"].every(label => parseMailBlocks(`[${label}](${url})`)[0].kind === "button"), true);
let tags = 0;
const html = bodyHtml(`[ ](${url})`, href => { tags++; return href + "&source=test"; });
is("fallback keeps a single tagged original destination", [tags, html.includes("guide?one=1&amp;two=2&amp;source=test\"")], [1, true]);
is("label markup stays text", bodyHtml('[<img src=x onerror=alert(1)>](https://example.com)').includes("<img"), false);
function luminance(hex: string) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
let seed = 0x13579bdf;
let bad = 0;
for (let i = 0; i < 4096; i++) {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  const accent = "#" + ((seed >>> 0) & 0xffffff).toString(16).padStart(6, "0");
  const rendered = bodyHtml(`[Guide](${url})`, undefined, accent);
  const fill = rendered.match(/background:(#[0-9a-f]{6})/i)?.[1] ?? "";
  const ink = rendered.match(/;color:(#[0-9a-f]{6})/i)?.[1] ?? "";
  const a = luminance(fill), b = luminance(ink);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  if (!Number.isFinite(ratio) || ratio < 7) bad++;
}
is("4096 deterministic colors meet 7:1 in emitted CSS, without production luminance helpers", bad, 0);
is("known readable input colors stay literal", ["#000000", "#FFFFFF", "#4c1d95"].every(color => bodyHtml(`[Guide](${url})`, undefined, color).includes(`background:${color};`)), true);
done();
