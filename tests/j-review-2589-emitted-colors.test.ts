import assert from "node:assert/strict";
import test from "node:test";
import { bodyHtml } from "@/lib/mail-body";

function luminance(hex: string) {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((s) => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function emitted(accent: string) {
  const html = bodyHtml("[Read the guide](https://example.com/guide)", undefined, accent);
  const colors = /background:(#[\da-f]{6});color:(#[\da-f]{6});font-weight:700/i.exec(html);
  assert.ok(colors, "a named button must contain explicit emitted fill and ink");
  assert.ok(html.includes('href="https://example.com/guide"') && html.includes(">Read the guide</a>"));
  return { fill: colors[1], ink: colors[2] };
}

test("control: existing dark accents preserve their fills and both contrast targets", () => {
  for (const accent of ["#4c1d95", "#000000"]) {
    const colors = emitted(accent);
    assert.equal(colors.fill, accent);
    assert.ok(contrast(colors.fill, colors.ink) >= 7 && contrast(colors.fill, "#ffffff") >= 3);
  }
});

for (const accent of ["#ffffff", "#ffdd00"]) test(`${accent} keeps a distinguishable control against the actual white card`, () => {
  const colors = emitted(accent);
  assert.ok(contrast(colors.fill, colors.ink) >= 7);
  assert.ok(contrast(colors.fill, "#ffffff") >= 3);
});

test("4096 deterministic RGB samples meet both unrounded targets in emitted CSS", () => {
  let state = 0x31a9, failures = 0;
  const examples: string[] = [];
  for (let i = 0; i < 4096; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const accent = "#" + (state & 0xffffff).toString(16).padStart(6, "0");
    const colors = emitted(accent);
    if (contrast(colors.fill, colors.ink) < 7 || contrast(colors.fill, "#ffffff") < 3) {
      failures++;
      if (examples.length < 3) examples.push(accent);
    }
  }
  assert.equal(failures, 0, `failing samples=${failures}; examples=${examples.join(",")}`);
});
