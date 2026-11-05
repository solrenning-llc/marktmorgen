/** Read-only render controls. A separate bundle may provide a synthetic opening value. */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeData } from "@/components/structured-data";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";
import { PUBLISHED_PLAN_PRICES, TIERS } from "@/lib/plan";

let checks = 0;
for (const value of ["Plain question", "</script><script>alert('synthetic')</script>", "< & \u2028 \u2029", "Café 📚"]) {
  const questions = Object.freeze([Object.freeze({ q: value, a: `Answer: ${value}` })]);
  const before = JSON.stringify(questions);
  const html = renderToStaticMarkup(createElement(HomeData, { questions: [...questions] }));
  assert.equal((html.match(/<script/g) ?? []).length, 1); checks++;
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1); checks++;
  const body = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(body); checks++;
  const graph = JSON.parse(body)["@graph"];
  assert.equal(graph.length, 2); checks++;
  const [application, faq] = graph;
  assert.equal(Object.hasOwn(application, "offers"), PLANS_ON_SALE); checks++;
  if (PLANS_ON_SALE) {
    assert.deepEqual(application.offers.map((offer: { price: string }) => offer.price), TIERS.map(tier => (PUBLISHED_PLAN_PRICES[tier].month / 100).toFixed(2))); checks++;
  } else {
    assert.equal(application.description, PREVIEW_LINE); checks++;
    assert.equal(/free trial/i.test(application.description), false); checks++;
  }
  assert.equal(faq.mainEntity[0].name, value); checks++;
  assert.equal(faq.mainEntity[0].acceptedAnswer.text, `Answer: ${value}`); checks++;
  assert.equal(JSON.stringify(questions), before); checks++;
}
console.log(`${checks} independent markup checks passed; synthetic opening=${PLANS_ON_SALE}`);
