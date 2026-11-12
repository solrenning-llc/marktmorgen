/** The installable application's actual metadata describes an available setup action. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { PREVIEW_LINE } from "@/lib/opening";

const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));

test("the installable application describes setting up a store without claiming payments are available", () => {
  assert.match(PREVIEW_LINE, /open a store and set it up today/);
  assert.doesNotMatch(manifest.description, /payments are processed|buyers pay|start selling|accept payments/i);
  assert.match(manifest.description, /^Set up your creator storefront for /);
  for (const offer of ["digital products", "courses", "memberships", "booked sessions"]) {
    assert.ok(manifest.description.includes(offer), "the existing store's offer types remain described");
  }
});

test("honest install copy keeps the existing application identity and launch behavior", () => {
  assert.deepEqual(
    [manifest.name, manifest.short_name, manifest.start_url, manifest.scope, manifest.display, manifest.orientation, manifest.lang],
    ["Marktmorgen — creator store", "Marktmorgen", "/?source=pwa", "/", "standalone", "portrait", "en"],
  );
  assert.deepEqual(manifest.shortcuts.map((shortcut: { url: string }) => shortcut.url), ["/demo", "/creators"]);
});

test("the existing install icons and theme remain available", () => {
  assert.deepEqual([manifest.background_color, manifest.theme_color], ["#f7f5f0", "#111827"]);
  assert.deepEqual(manifest.icons, [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);
  for (const icon of manifest.icons) assert.equal(existsSync("public" + icon.src), true);
});
