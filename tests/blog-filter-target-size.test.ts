import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogBrowser } from "@/components/blog-browser";
import { BLOG_CATEGORIES, postsSorted } from "@/lib/blog";

async function main() {
  const html = renderToStaticMarkup(createElement(BlogBrowser, {
    posts: postsSorted(), categories: [...BLOG_CATEGORIES],
  }));
  const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)]
    .filter(([, attrs]) => attrs.includes("aria-pressed="))
    .map(([, attrs, name]) => ({ attrs, name }));
  assert.deepEqual(buttons.map(({ name }) => name), ["All articles", ...BLOG_CATEGORIES],
    "the real blog retains every category in its original order");
  assert.deepEqual(buttons.map(({ attrs }) => attrs.match(/aria-pressed="([^"]*)"/)?.[1]),
    buttons.map((_, i) => String(i === 0)), "only All articles starts selected");
  assert.ok(buttons.every(({ attrs }) => /type="button"/.test(attrs)),
    "category controls remain ordinary buttons");
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const classes = buttons.map(({ attrs }) => attrs.match(/class="([^"]*)"/)?.[1].split(/\s+/) ?? []);
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
  const css = compiler.build(classes.flat());
  assert.match(css, /--spacing:\s*0\.25rem/, "actual CSS retains the quarter-rem spacing scale");
  for (const [i, tokens] of classes.entries()) {
    const height = tokens.find((token) => /^h-\d+$/.test(token));
    assert.ok(height && Number(height.slice(2)) * 4 >= 44,
      `${buttons[i].name}: the real category target is at least 44px tall`);
    assert.ok(css.includes(`.${height} {`) && css.includes(`height: calc(var(--spacing) * ${height.slice(2)})`),
      `${buttons[i].name}: actual stylesheet emits the target height`);
  }
  console.log(`Blog filters: ${buttons.length} real category targets, names, order, selection and compiled heights passed`);
}

void main();
