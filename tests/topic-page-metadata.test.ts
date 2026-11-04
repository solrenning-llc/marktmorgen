/**
 * 271 [SEO1]: every topic page tells search engines the title and
 * description written for it. /platform and /for used to ignore a page's own
 * `seo` and send the generic "<title> <highlight> — Marktmorgen" instead;
 * and no two pages may share a title or a description.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PAGES } from "@/lib/site-pages";
import { generateMetadata as platformMeta } from "@/app/platform/[slug]/page";
import { generateMetadata as forMeta } from "@/app/for/[slug]/page";
import { generateMetadata as proofMeta } from "@/app/proof/[slug]/page";

const routes = { platform: platformMeta, for: forMeta, proof: proofMeta } as const;

test("a page's own search title and description are the ones sent", async () => {
  const seen = { titles: new Map<string, string>(), descriptions: new Map<string, string>() };
  for (const page of PAGES) {
    const meta = await routes[page.section as keyof typeof routes]({ params: Promise.resolve({ slug: page.slug }) });
    const where = `/${page.section}/${page.slug}`;
    if (page.seo) {
      assert.equal(meta.title, page.seo.title, where);
      assert.equal(meta.description, page.seo.description, where);
    }
    const title = String(meta.title);
    const description = String(meta.description);
    assert.ok(!seen.titles.has(title), `${where} shares its title with ${seen.titles.get(title)}`);
    assert.ok(!seen.descriptions.has(description), `${where} shares its description with ${seen.descriptions.get(description)}`);
    seen.titles.set(title, where);
    seen.descriptions.set(description, where);
  }
  assert.ok(seen.titles.size === PAGES.length);
});
