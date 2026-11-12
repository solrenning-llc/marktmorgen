import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { LookEditor } from "@/components/look-editor";
import { ACCENTS, parseLook } from "@/lib/store-look";

async function main() {
  // Load the installed compiler at runtime: its native CSS dependency must
  // not be folded into the test runner's temporary JavaScript bundle.
  const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, {
    value: { refresh() {} } as never,
  }, createElement(LookEditor, {
    look: parseLook({}), photoId: null, name: "Harbor Studio", handle: "harbor",
  })));
  const field = html.match(/<fieldset[^>]*><legend[^>]*>Your color<\/legend>([\s\S]*?)<\/fieldset>/)?.[1];
  assert.ok(field, "the real editor renders its named color group");
  const labels = [...field.matchAll(/<label\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/label>/g)];
  assert.equal(labels.length, ACCENTS.length + 1, "every preset and the custom picker keep their labels");
  const candidates = labels.flatMap((label) => label[1].split(/\s+/));
  const compiler = await compile(readFileSync("app/globals.css", "utf8"), {
    base: process.cwd(), onDependency() {},
  });
  const css = compiler.build(candidates);
  let checked = 0;
  for (const [, classes, body] of labels) {
    const custom = body.includes('type="color"');
    assert.ok(custom ? body.includes("Your own") : body.includes('class="sr-only"'), "each target retains its accessible name");
    const height = classes.split(/\s+/).find((c) => /^h-\d+$/.test(c));
    assert.ok(height && Number(height.slice(2)) * 4 >= 44, "each real color label is at least 44px tall");
    assert.ok(css.includes(`.${height} {`) && css.includes(`height: calc(var(--spacing) * ${height.slice(2)})`), "the real stylesheet emits the label height");
    if (!custom) {
      const width = classes.split(/\s+/).find((c) => /^w-\d+$/.test(c));
      assert.ok(width && Number(width.slice(2)) * 4 >= 44, "preset labels are at least 44px wide");
    }
    checked++;
  }
  assert.match(css, /--spacing:\s*0\.25rem/, "Tailwind uses the existing quarter-rem spacing scale");
  console.log(`Color target regression: ${checked} real label targets passed with compiled CSS`);
}

void main();
