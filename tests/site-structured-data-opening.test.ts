import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteData } from "@/components/structured-data";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";

type SiteGraph = {
  "@graph": Array<{ "@type": string; description?: string }>;
};

function organizationDescription(): string {
  const html = renderToStaticMarkup(createElement(SiteData));
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "the real site component emits JSON-LD");
  const graph = (JSON.parse(match[1]) as SiteGraph)["@graph"];
  const organization = graph.find((item) => item["@type"] === "Organization");
  assert.ok(organization?.description, "the organization has one reviewable description");
  return organization.description;
}

test("the global organization description follows current commercial availability", () => {
  const description = organizationDescription();
  if (!PLANS_ON_SALE) {
    assert.equal(description, PREVIEW_LINE);
    assert.doesNotMatch(description, /buyers? pay|stripe account/i);
    return;
  }
  assert.match(description, /buyers? pay/i);
  assert.ok(description.includes(feeWords().takesOfCreator));
});
