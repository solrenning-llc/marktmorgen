import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";

const ref = process.argv[2];
const path = "tests/e2e/deals-board-focus.mjs";
const source = ref ? execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" }) : readFileSync(path, "utf8");
const start = source.lastIndexOf("// 639 [GL7](7):");
assert.ok(start >= 0);
const end = source.indexOf('\n\n  is("no error in the page"', start);
assert.ok(end > start);
const block = source.slice(start, end);
const sentence = "You can see this pipeline but not change it.";

// Execute the exact production-test block against a deterministic pending commit.
// This is a scheduling stand-in, not a real browser or React rendering claim.
async function observe(initial, committed) {
  let state = { ...initial };
  const assertions = [];
  let waits = 0;
  const context = {
    document: { body: { get innerText() { return state.text; } } },
    world: value => value,
    mount: async () => {},
    page: {
      evaluate: async fn => fn(),
      waitForFunction: async fn => {
        waits++;
        if (!fn()) state = { ...committed };
        if (!fn()) throw new Error("observed sentence never committed");
      },
      locator: selector => ({ count: async () => selector === "#deal-board-view-only" ? state.notices : state.controls }),
    },
    is: (_name, got, want) => assertions.push({ got: JSON.parse(JSON.stringify(got)), want: JSON.parse(JSON.stringify(want)), ok: JSON.stringify(got) === JSON.stringify(want) }),
  };
  await vm.runInNewContext(`(async () => {${block}})()`, context, { timeout: 1000 });
  return { assertions, waits };
}
const ready = { text: sentence, notices: 1, controls: 0 };
test("D2: pending text and notice commit before the unchanged assertion", async () => {
  const result = await observe({ text: "", notices: 0, controls: 0 }, ready);
  assert.equal(result.assertions.length, 1);
  assert.equal(result.assertions[0].ok, true);
});
test("D2: a notice node alone does not make the text assertion ready", async () => {
  const result = await observe({ text: "", notices: 1, controls: 0 }, ready);
  assert.equal(result.assertions[0].ok, true);
});
test("D2: an already committed state retains the complete triple", async () => {
  const result = await observe(ready, ready);
  assert.deepEqual(result.assertions[0].got, [1, 1, 0]);
  assert.deepEqual(Array.from(result.assertions[0].want), [1, 1, 0]);
  assert.equal(result.assertions[0].ok, true);
});
test("D2: the gate cannot mask duplicate notices or change controls", async () => {
  for (const bad of [{ ...ready, text: `${sentence} ${sentence}` }, { ...ready, notices: 2 }, { ...ready, controls: 1 }, { ...ready, notices: 0 }]) {
    const result = await observe({ text: "", notices: 0, controls: 0 }, bad);
    assert.equal(result.assertions[0].ok, false);
  }
});
test("D2: a sentence that never arrives fails before a success assertion", async () => {
  await assert.rejects(observe({ text: "", notices: 0, controls: 0 }, { text: "", notices: 0, controls: 0 }), /never committed/);
});
