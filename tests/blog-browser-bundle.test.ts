/**
 * The blog's filter (components/blog-browser.tsx) is a browser component on /blog and on every post. It
 * formats a date. Importing that one function from lib/blog.ts sent every phone the text of every post and
 * guide, and through lib/community-platform-guide.ts the whole commercial review behind lib/opening.ts.
 * The date format lives in lib/post-date.ts, which carries nothing else.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { formatPostDate } from "@/lib/blog";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));
const { build } = nodeRequire("esbuild") as typeof import("esbuild");

/** Server-side content and decisions the blog filter's browser bundle must not carry. */
const KEPT_OUT = ["lib/blog.ts", "lib/evergreen-guides.ts", "lib/community-platform-guide.ts", "lib/opening.ts", "lib/commercial-margin.ts"];

test("the blog filter's browser bundle carries no post text and none of the opening review", async () => {
  // The same browser build tests/client-bundles.mjs makes of every client component.
  const result = await build({
    entryPoints: [join(process.cwd(), "components/blog-browser.tsx")],
    absWorkingDir: process.cwd(),
    bundle: true,
    write: false,
    metafile: true,
    minify: true,
    platform: "browser",
    format: "esm",
    nodePaths: [join(process.cwd(), "node_modules")],
    external: ["react", "react/*", "next/*"],
    tsconfig: join(process.cwd(), "tsconfig.json"),
    logLevel: "silent",
  });
  const inputs = Object.values(result.metafile!.outputs).flatMap((output) => Object.keys(output.inputs));
  assert.deepEqual(KEPT_OUT.filter((module) => inputs.includes(module)), []);
});

test("a post's date still reads the same, from lib/blog as before", () => {
  assert.equal(formatPostDate("2026-10-27"), "Oct 27, 2026");
  assert.equal(formatPostDate("2026-01-01"), "Jan 1, 2026");
});
