import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

test("synthetic font responses cover current root and approved home font requests", () => {
  const require = createRequire(join(process.cwd(), "package.json"));
  const responses = require(join(process.cwd(), "tests/e2e/google-fonts-mock.cjs")) as Record<string, string>;
  for (const [query, family, weight] of [
    ["Geist:wght@100..900", "Geist", "100 900"],
    ["Instrument+Serif:ital,wght@0,400;1,400", "Instrument Serif", "400"],
    ["Figtree:wght@300..900", "Figtree", "300 900"],
    ["Unbounded:wght@600;800", "Unbounded", "600 800"],
  ]) {
    const css = responses[`https://fonts.googleapis.com/css2?family=${query}&display=optional`];
    assert.equal(typeof css, "string", `missing exact Next font request: ${family}`);
    assert.ok(css.includes(`font-family: '${family}'`));
    assert.ok(css.includes(`font-weight: ${weight}`));
    assert.ok(css.includes("font-display: optional"));
    assert.ok(css.includes("/fonts/mock.woff2"));
    assert.ok(!css.includes("fonts.gstatic.com"), "synthetic builds must not depend on live provider files");
  }
  assert.ok(responses["https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap"].includes("font-display: swap"),
    "existing root-font responses retain their display mode");
});
