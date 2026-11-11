import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogBrowser } from "@/components/blog-browser";
import { BLOG_CATEGORIES, postsSorted } from "@/lib/blog";

async function main() {
  const html = renderToStaticMarkup(createElement(BlogBrowser, { posts: postsSorted(), categories: [...BLOG_CATEGORIES] }));
  const group = html.match(/<div[^>]*class="([^"]*)"[^>]*role="group"[^>]*aria-label="Filter articles by category"/);
  assert.ok(group, "the actual category group is rendered");
  const tokens = group[1].split(/\s+/);
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(tokens);
  assert.ok(tokens.includes("flex-wrap") && css.includes("flex-wrap: wrap"), "actual category row wraps at narrow widths so native focus is never clipped horizontally");
  assert.ok(!tokens.includes("overflow-x-auto"), "category targets do not depend on a partially visible horizontal scroll strip");
  const names = [...html.matchAll(/<button[^>]*aria-pressed="[^"]*"[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(names, ["All articles", ...BLOG_CATEGORIES], "all real categories retain their accessible names and order");
  console.log("Blog category layout: real labels/order and compiled wrapping contract pass");
}
void main();
