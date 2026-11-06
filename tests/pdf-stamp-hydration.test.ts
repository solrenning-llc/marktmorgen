import { readFileSync } from "node:fs";

let checks = 0;
function is(name: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log("  ok   ", name);
}

const source = readFileSync("tests/e2e/pdf-stamp-acknowledgment.mjs", "utf8");
const control = source.indexOf('const select=page.locator(\'[id="stamp-\'+fixture.product+\'"]\')');
const reactProps = source.indexOf('key.startsWith("__reactProps$")');
const hydrated = source.indexOf('typeof element[key]?.onChange==="function"');
const firstScenario = source.indexOf("for(const scenario of cases)");

is("the real stamp control is still the hydration target", control >= 0, true);
is("the test finds React's props on the real checkbox", reactProps >= 0, true);
is("the test observes React's installed change handler", hydrated >= 0, true);
is("hydration is observed before the first scenario can click", reactProps > control && hydrated > reactProps && hydrated < firstScenario, true);
is("the regression uses no fixed sleep", /setTimeout|waitForTimeout/.test(source), false);

console.log(`\n${checks} checks, all passing.`);
