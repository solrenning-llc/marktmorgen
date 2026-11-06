import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";
const topic = source("components/topic-page.tsx");
const component = source("components/feature-captures.tsx");
type Capture = { slug: string; context: string; sourcePath: string; sourceCommit: string; capturedAt: string; width: number; height: number; sha256: string; src: string; alt: string };
const manifest = source("lib/feature-captures.ts").match(/export const FEATURE_CAPTURES = (\[[\s\S]*?\]) as const;/)?.[1];
const captures: Capture[] = manifest ? JSON.parse(manifest) : [];

test("the actual platform hero can show captures without removing the illustration fallback", () => {
  assert.match(topic, /FeatureCapture/);
  assert.match(topic, /page\.section === "platform"/);
  assert.match(topic, /<FeatureVisual visual=\{page\.visual\}/);
  assert.match(component, /return null/);
});

test("only the two matching resource pages receive dated actual-interface captures", () => {
  assert.deepEqual(captures.map(c => [c.slug, c.context]), [["store-page", "Demo store"], ["sales-pages", "Synthetic studio"]]);
  for (const capture of captures) {
    assert.match(capture.sourceCommit, /^[a-f0-9]{40}$/);
    assert.ok(Number.isFinite(Date.parse(capture.capturedAt)), "capture timestamp must be an exact valid date");
    assert.ok(capture.sourcePath.startsWith(capture.context === "Demo store" ? "/@" : "/studio/pages?"));
    assert.equal(capture.width, 1280);
    assert.equal(capture.height, 820);
    assert.match(capture.alt, /fictional/i);
    assert.doesNotMatch(capture.alt, /guarantee|earnings|testimonial/i);
  }
});

test("published pixels have a bounded verified image payload, never a remote optimizer or generated illustration", () => {
  assert.equal(captures.length, 2);
  for (const capture of captures) {
    assert.equal(capture.src, `/feature-captures/${capture.slug}.webp`, "C4-1150: pixels are separately cacheable static assets, not duplicated inline payload");
    const pixels = readFileSync(`public${capture.src}`);
    assert.equal(pixels.subarray(0, 4).toString(), "RIFF");
    assert.equal(pixels.subarray(8, 12).toString(), "WEBP");
    assert.ok(pixels.length > 1000 && pixels.length <= 100_000, "one static capture is capped before publishing");
    assert.equal(createHash("sha256").update(pixels).digest("hex"), capture.sha256);
  }
});

test("provenance is visible beside the actual pixels", () => {
  assert.match(component, /<figure/);
  assert.match(component, /<figcaption/);
  assert.match(component, /fictional test content/);
  assert.match(component, /not a customer result/);
  assert.match(component, /loading="lazy"/);
  assert.match(component, /decoding="async"/);
  assert.match(topic, /FeatureVisual/);
});

test("the existing closed-plan notice remains in the actual renderer", () => {
  assert.match(topic, /!PLANS_ON_SALE/);
  assert.match(topic, /Paid plans are not on sale yet\. You can open a store and set it up today\./);
});
