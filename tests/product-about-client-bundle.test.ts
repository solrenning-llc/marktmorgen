/**
 * lib/product-about.ts is read by the studio's product editor in the browser (MAX_ABOUT_LENGTH, aboutBlocks), so it
 * must never reach lib/store.ts and its server-only modules (node:crypto, node:perf_hooks): in #4969 it imported
 * lib/store for the erasure fence, and `next build` broke on /studio/page. The fenced writers live in the server-only
 * lib/product-about-live.ts. Each client component that imports lib/product-about.ts is bundled here for the browser,
 * as tests/client-bundles.mjs does, with no Node polyfill.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

/** Every client component (app/ and components/) that imports lib/product-about.ts, found from the files themselves. */
function clientReaders(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(join(process.cwd(), name), "utf8");
        if (/^\s*["']use client["'];/m.test(source) && /from "@\/lib\/product-about"/.test(source)) found.push(name);
      }
    }
  };
  walk("app");
  walk("components");
  return found.sort();
}

test("lib/product-about.ts imports neither lib/store nor the server-only fenced writers", () => {
  const source = readFileSync(join(process.cwd(), "lib/product-about.ts"), "utf8");
  assert.doesNotMatch(source, /from "@\/lib\/store"/);
  assert.doesNotMatch(source, /from "@\/lib\/product-about-live"/);
});

test("every client component that reads lib/product-about.ts still bundles for the browser", async () => {
  const readers = clientReaders();
  // The studio's product editor is the one known today; finding none would mean this test checks nothing.
  assert.ok(readers.includes("components/product-editor.tsx"), "the product editor is found as a client reader");
  for (const entry of readers) {
    let errors: string[] = [];
    try {
      await build({
        absWorkingDir: process.cwd(),
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        nodePaths: [join(process.cwd(), "node_modules")],
        external: ["react", "react/*", "next/*"],
        tsconfig: join(process.cwd(), "tsconfig.json"),
        logLevel: "silent",
      });
    } catch (error) {
      errors = ((error as { errors?: { text: string }[] }).errors ?? [{ text: String(error) }]).map((item) => item.text);
    }
    assert.deepEqual(errors, [], `${entry} bundles for the browser`);
  }
});
