/**
 * The parts of tests/e2e/store-copy.mjs that CI runs on separate machines (STORE_COPY_PART,
 * .github/workflows/product-checks.yml): every step imported by the file is in its list once,
 * the parts are contiguous, keep the file order and together are every step, and only part 1
 * runs the studio journey; a mistyped part or a boundary that is not a step fails.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";
import { STORE_COPY_BOUNDARIES, parseStoreCopyPart, storeCopyPartSteps } from "./e2e/store-copy-parts.mjs";

const source = readFileSync("tests/e2e/store-copy.mjs", "utf8");
const names = [...source.matchAll(/^ {4}\["(\w+)", \(\) => (?:publicStandardAx2Run\(\) \? )?(\w+)\(/gm)];
const steps = names.map((match) => match[1]);
const workflow = readFileSync(".github/workflows/product-checks.yml", "utf8");

part("the step list of store-copy.mjs");
is("each entry calls the step it is named for", names.every((match) => match[1] === match[2]), true);
is("no step is listed twice", new Set(steps).size, steps.length);
const imported = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\/[^"]+";$/gm)]
  .flatMap((match) => match[1].split(",").map((name) => name.trim()))
  .filter((name) => /^(check|capture)\w+$/.test(name));
const calledElsewhere = imported.filter((name) => !steps.includes(name));
is("every imported check runs either as a step or in the studio journey",
  calledElsewhere.every((name) => new RegExp(`await ${name}\\(`).test(source)), true);
is("the steps run only through the chosen part", /for \(const \[name, step\] of steps\) if \(running\.has\(name\)\) await step\(\);/.test(source), true);
is("the studio journey runs only in part 1 or in a full run", /\n {2}if \(chosen\.journey\) \{\n/.test(source), true);

part("three contiguous parts that together are every step");
const total = STORE_COPY_BOUNDARIES.length + 1;
const parts = Array.from({ length: total }, (_, index) => storeCopyPartSteps(steps, { index: index + 1, total }));
is("together, in order, they are the whole list", parts.flatMap((one) => one.steps), steps);
is("only part 1 runs the studio journey", parts.map((one) => one.journey), [true, ...Array(total - 1).fill(false)]);
is("every part runs at least one step", parts.every((one) => one.steps.length > 0), true);
is("a full run is the journey and every step", storeCopyPartSteps(steps, null), { journey: true, steps });
is("CI runs exactly these parts", workflow.match(/\n {8}part: \[([0-9, ]+)\]\n/g)?.length, 2);
is("CI names the same number of parts", [...workflow.matchAll(/STORE_COPY_PART: \$\{\{ matrix\.part \}\}\/(\d+)\n/g)].map((match) => Number(match[1])), [total, total]);

part("a mistyped part or boundary fails instead of skipping steps");
const throws = (run: () => unknown) => { try { run(); return false; } catch { return true; } };
is("unset or empty is a full run", [parseStoreCopyPart(undefined), parseStoreCopyPart("")], [null, null]);
is("bad part values throw", ["0/3", "4/3", "1", "a/3", "1/3 ", "01/3"].map((spec) => throws(() => parseStoreCopyPart(spec))), Array(6).fill(true));
is("a part count that does not match throws", throws(() => storeCopyPartSteps(steps, { index: 1, total: total + 1 })), true);
is("a boundary that is not a step throws", throws(() => storeCopyPartSteps(steps, null, ["noSuchStep"])), true);
is("boundaries out of order throw", throws(() => storeCopyPartSteps(steps, null, [...STORE_COPY_BOUNDARIES].reverse())), true);

done();
