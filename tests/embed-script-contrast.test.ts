/**
 * Real generated checkout links must keep readable text even for unsafe
 * input colors. WCAG 2.2 SC 1.4.6, read November 4, 2026:
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html
 * The 16px label requires 7:1, without rounding the threshold.
 * No browser, provider or WordPress installation is simulated here.
 */
import { createHash } from "node:crypto";
import { loaderSource, scriptCode } from "@/lib/embed-sdk";
import { done, is, part } from "./check";

const base = { handle: "synthetic-store", productId: "abc123", place: "blog", text: "Buy this course", mode: "page" as const, withScript: false };
const colors = (html: string): [string, string] => {
  const match = /background:(#[0-9a-f]{6});color:(#[0-9a-f]{6});/i.exec(html);
  if (!match) throw new Error("The real link has no complete color pair");
  return [match[1], match[2]];
};
/** Independent calculation on the emitted CSS, not the input or product helper. */
function ratio([background, foreground]: [string, string]): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const linear = channels.map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(background), b = luminance(foreground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

part("Unsafe color pairs still produce readable checkout text");
const unsafe: [string, string][] = [
  ["#ffffff", "#ffffff"], ["#15112e", "#15112e"],
  ["#ffffff", "#aaaaaa"], ["#ff0000", "#000000"],
  ["#ffffff", "#5a5a5a"], ["#777777", "#ffffff"], ["#5a36ee", "#ffffff"],
  ["#15112e", "invalid"], ["#15112e", ""],
  ["invalid", "invalid"], ["red;background:url(x)", "red"],
];
for (const [fill, onFill] of unsafe) {
  const emitted = colors(scriptCode({ ...base, fill, onFill }));
  is(`${fill}/${onFill || "empty"}: actual label contrast is at least 7`, ratio(emitted) >= 7, true);
}

part("Already readable choices are preserved exactly");
const readable: [string, string][] = [
  ["#15112e", "#ffffff"], ["#000000", "#FFFFFF"],
  ["#ffffff", "#000000"], ["#ff6600", "#000000"],
  ["#ffffff", "#595959"],
];
for (const [fill, onFill] of readable) {
  is(`${fill}/${onFill}: the test's positive pair is readable`, ratio([fill, onFill]) >= 7, true);
  is(`${fill}/${onFill}: both literal colors stay`, colors(scriptCode({ ...base, fill, onFill })), [fill, onFill]);
}

part("Only the generated link's colors change");
const html = scriptCode({ ...base, fill: "#ffffff", onFill: "#ffffff", text: 'Buy <this> & "that"' });
is("the same destination, mode and referrer policy remain", html.includes('href="https://marktmorgen.com/embed/synthetic-store/abc123?mm=page&amp;utm_source=blog&amp;utm_medium=checkout-script" data-mm="page" referrerpolicy="origin"'), true);
is("the creator's label remains escaped", html.endsWith('>Buy &lt;this&gt; &amp; &quot;that&quot;</a>'), true);
// Version 2 of the loader (the browser's own modal dialog, 2.4.3/2.4.13, Close's outline in forced colors, 2.4.7, and the card taking the focus only on its first load, 3.2.1) is its own exact bytes; any other change needs a new version.
is("the loader keeps the exact SHA-256 of its version 2", createHash("sha256").update(loaderSource("https://marktmorgen.com")).digest("hex"), "bc0cbc002294d3130810cfac02b1de56593061a0fd90e4387450d1359207db68");
done();
