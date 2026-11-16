import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("tests/e2e/mobile-render.mjs", "utf8");

test("mobile interaction timing waits for the control to stop moving", () => {
  const helper = runner.indexOf("async function waitUntilControlSettles");
  const interactionLoop = runner.indexOf("for(let interaction=0;interaction<3;interaction++)");
  const wait = runner.indexOf("await waitUntilControlSettles(page,control)", interactionLoop);
  const metrics = runner.indexOf("const start=await metrics()", interactionLoop);
  const click = runner.indexOf("await control.click()", interactionLoop);

  assert.ok(helper >= 0, "the runner needs an observed control-settling helper");
  assert.ok(interactionLoop >= 0, "the three-interaction coverage remains present");
  assert.ok(wait > interactionLoop && wait < metrics && metrics < click,
    "every timed click starts only after the target has visibly settled");

  const helperEnd = runner.indexOf("\n// 281 [SF1]", helper);
  const body = runner.slice(helper, helperEnd);
  assert.match(body, /scrollIntoViewIfNeeded/);
  assert.match(body, /getBoundingClientRect/);
  assert.match(body, /polling:"raf"/);
  assert.doesNotMatch(body, /setTimeout|waitForTimeout/,
    "readiness is an observed browser event, never a fixed delay");
});

test("the mobile render coverage and strict thresholds stay unchanged", () => {
  assert.match(runner, /for\(let sample=1;sample<=3;sample\+\+\)/);
  assert.match(runner, /for\(let interaction=0;interaction<3;interaction\+\+\)/);
  assert.match(runner, /before\.lcp<2500/);
  assert.match(runner, /before\.cls<0\.1/);
  assert.match(runner, /interactionMs<200/);
  // Every sample is judged with the same bounds (tests/e2e/mobile-render-judge.mjs); only a missed interaction is
  // measured again, once, and a second miss fails (Claude 2, 13 November 2026). Held exactly by
  // tests/mobile-render-judge.test.ts; here, that the runner uses it and fails on its verdict.
  assert.match(runner, /judgeSample\(\{label,apiWrites:writes,lcpMs:before\.lcp,cls:before\.cls,interactionToPaintMs:interactionMs\},attempt\)/);
  assert.match(runner, /if\(judged\.verdict==="fail"\)\{failed=true;/);
  assert.match(runner, /for\(let attempt=1;attempt<=2;attempt\+\+\)/);
  const judge = readFileSync("tests/e2e/mobile-render-judge.mjs", "utf8");
  assert.match(judge, /LCP_BOUND_MS = 2500;/);
  assert.match(judge, /CLS_BOUND = 0\.1;/);
  assert.match(judge, /INTERACTION_BOUND_MS = 200;/);
});
