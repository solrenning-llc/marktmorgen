import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TopicPageView } from "@/components/topic-page";
import { PAGES, type TopicPage } from "@/lib/site-pages";

function render(page: TopicPage): string {
  return renderToStaticMarkup(createElement(TopicPageView, { page }));
}

const rendered = PAGES.map((page) => ({ path: `/${page.section}/${page.slug}`, html: render(page) }));

test("every native fragment link on every published topic page has exactly one destination", () => {
  const broken: { path: string; fragment: string; destinations: number }[] = [];
  for (const { path, html } of rendered) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    for (const [, fragment] of html.matchAll(/href="#([^"]+)"/g)) {
      const destinations = ids.filter((id) => id === fragment).length;
      if (destinations !== 1) broken.push({ path, fragment, destinations });
    }
  }
  assert.deepEqual(broken, []);
  assert.equal(rendered.length, PAGES.length);
});

test("every note is a named section whose title is the fragment destination", () => {
  const unnamed: string[] = [];
  let notes = 0;
  for (const { path, html } of rendered) {
    const sections = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)];
    for (const [, attributes, body] of sections) {
      // Identify the existing visible note panel before testing its semantics.
      if (!attributes.includes("bg-sand p-6")) continue;
      notes++;
      const heading = /<h2\b([^>]*)>/.exec(body);
      const id = heading && /\bid="([^"]+)"/.exec(heading[1])?.[1];
      const namedBy = /\baria-labelledby="([^"]+)"/.exec(attributes)?.[1];
      if (!id || namedBy !== id) unnamed.push(path);
    }
  }
  const expectedNotes = PAGES.flatMap((page) => page.blocks.filter((block) => block.kind === "note")).length;
  assert.ok(expectedNotes > 0, "the real public pages contain note blocks");
  assert.equal(notes, expectedNotes, "every rendered note panel was checked");
  assert.deepEqual(unnamed, []);
});

test("the availability note in the comparison index has a working native link", () => {
  const page = rendered.find(({ path }) => path === "/proof/comparisons")!;
  assert.ok(page);
  const target = "availability-matters-as-much-as-price";
  assert.ok(page.html.includes(`href="#${target}"`));
  assert.ok(page.html.includes(`<h2 id="${target}"`));
  assert.ok(page.html.includes("Marktmorgen&#x27;s paid plans are not on sale yet."));
});

test("note titles with punctuation keep safe native destinations and their visible words", () => {
  const page: TopicPage = {
    ...PAGES.find((item) => item.section === "proof")!,
    blocks: [
      { kind: "note", title: "Before you choose: limits & fees", body: "Read the actual terms." },
      { kind: "note", title: "After you choose: your account", body: "Keep your account records." },
    ],
  };
  const html = render(page);
  assert.ok(html.includes("Before you choose: limits &amp; fees"));
  assert.ok(html.includes('href="#before-you-choose-limits-fees"'));
  assert.ok(html.includes('id="before-you-choose-limits-fees"'));
  assert.ok(html.includes('aria-labelledby="before-you-choose-limits-fees"'));
  assert.ok(html.includes('id="after-you-choose-your-account"'));
});
