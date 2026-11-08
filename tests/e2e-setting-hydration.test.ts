import { existsSync, readFileSync } from "node:fs";

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

const helperPath = "tests/e2e/react-hydration.mjs";
const helper = existsSync(helperPath) ? readFileSync(helperPath, "utf8") : "";
is("one shared helper owns the React change-handler observation", helper.length > 0, true);
is(
  "the helper observes the control's installed onChange instead of a timer",
  helper.includes('key.startsWith("__reactProps$")') &&
    helper.includes('typeof element[key]?.onChange==="function"') &&
    !/setTimeout|waitForTimeout/.test(helper),
  true,
);

const cases = [
  ["cart-acknowledgment.mjs", "check", "await check.check()"],
  ["contact-acknowledgment.mjs", "toggle", "const original=await toggle.isChecked()"],
  ["dunning-acknowledgment.mjs", "count", 'await count.selectOption(on?"3":"2")'],
  ["leave-acknowledgment.mjs", "onField", "await onField.check()"],
  ["nudge-acknowledgment.mjs", "toggle", "await toggle.setChecked(true)"],
  ["numbers-acknowledgment.mjs", "label", "await label.fill(draft)"],
  ["recovery-acknowledgment.mjs", "toggle", "await toggle.setChecked(true)"],
  ["signup-setting-acknowledgment.mjs", "toggle", "const original=await toggle.isChecked()"],
  ["support-setting-acknowledgment.mjs", "toggle", "const original=await toggle.isChecked()"],
  ["yearly-acknowledgment.mjs", "check", "for(const on of [true,false])"],
] as const;

for (const [file, control, firstEdit] of cases) {
  const source = readFileSync(`tests/e2e/${file}`, "utf8");
  const imported = source.indexOf('import {waitForReactChangeHandler} from "./react-hydration.mjs";');
  const observed = source.indexOf(`await waitForReactChangeHandler(page,${control});`);
  const edited = source.indexOf(firstEdit);
  is(`${file} uses the shared hydration observer`, imported >= 0, true);
  is(`${file} observes its real control before the first edit`, observed > imported && observed < edited, true);
}

console.log(`\n${checks} checks complete.`);
