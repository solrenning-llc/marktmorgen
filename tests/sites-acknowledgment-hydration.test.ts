import { readFileSync } from "node:fs";

let checks = 0;
function is(name: string, actual: unknown, expected: unknown) {
  checks += 1;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`not ok ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
    return;
  }
  console.log("  ok   ", name);
}

const source = readFileSync("tests/e2e/sites-acknowledgment.mjs", "utf8");
const helper = readFileSync("tests/e2e/react-hydration.mjs", "utf8");
const imported = source.indexOf('import {waitForReactChangeHandler} from "./react-hydration.mjs";');
const field = source.indexOf('const field=section.locator("textarea").first()');
const observed = source.indexOf("await waitForReactChangeHandler(page,field);");
const firstFill = source.indexOf("await field.fill(raw)");

is("the sites test imports the shared hydration observer", imported >= 0, true);
is("the observer targets the real sites field", field >= 0 && observed > field, true);
is("hydration is observed before the first fill", observed > field && observed < firstFill, true);
is(
  "the shared helper waits for React's installed change handler",
  helper.includes('key.startsWith("__reactProps$")') &&
    helper.includes('typeof element[key]?.onChange==="function"'),
  true,
);
is("the regression introduces no fixed sleep", /setTimeout|waitForTimeout/.test(source), false);

console.log(`\n${checks} checks complete.`);
