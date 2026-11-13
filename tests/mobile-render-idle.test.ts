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

test("the browser is first warmed once, unmeasured, in a throwaway context", () => {
  // On a fresh CI runner only the first sample used to pay the browser's own
  // cold start ("/" sample 1 alone failed, samples 2 and 3 passed: jobs
  // 130411049774, 130644246553, 130347815266). Removing this visit brings that
  // run-order penalty back. Only "/" is warmed, never a measured route's first
  // server render (#3900 review; tests/mobile-render-warm-browser-only.test.ts).
  const warmStart = runner.indexOf('const WARM_PATH="/";');
  const measuredLoop = runner.indexOf("for(const path of PATHS)for(let sample=1;sample<=3;sample++)");
  assert.ok(warmStart >= 0, "the warm-up visit of the browser remains");
  assert.ok(measuredLoop > warmStart, "the warm-up comes before the first measured sample");
  assert.equal(runner.indexOf('const WARM_PATH="/";', warmStart + 1), -1, "a single warm-up visit");

  const warm = runner.slice(warmStart, measuredLoop);
  assert.match(warm, /browser\.newContext\(PHONE\)/, "its own context, on the measured phone");
  assert.match(warm, /finally\{await context\.close\(\);\}/, "the throwaway context is closed before measuring");
  assert.match(warm, /openPhone\(context,WARM_PATH,/, "same network, CPU, cold cache, request policy and observers");
  assert.match(warm, /loadAndSettle\(page,WARM_PATH\)/, "same load and settling as a measured sample");
  assert.match(warm, /for\(let tap=1;tap<=3;tap\+\+\)\{await waitUntilControlSettles\(page,control\);await control\.click\(\)/,
    "the same three taps on the same control");
  assert.doesNotMatch(warm, /MOBILE_RENDER_MEASUREMENT|results\.push|failed=|targets|metrics\(/,
    "nothing from the warm-up is recorded or judged");

  const measured = runner.slice(measuredLoop);
  assert.match(measured, /^for\(const path of PATHS\)for\(let sample=1;sample<=3;sample\+\+\)\{\n  const context=await browser\.newContext\(PHONE\);/,
    "every measured sample still starts in a new context");
  assert.match(measured, /openPhone\(context,path,counts\)/);
  assert.match(measured, /loadAndSettle\(page,path\)/);
  assert.match(measured, /page\.locator\(CONTROL\)/, "the measured control is the same selector as the warmed one");

  const phone = runner.slice(runner.indexOf("async function openPhone"), runner.indexOf("async function loadAndSettle"));
  assert.match(phone, /setCPUThrottlingRate",\{rate:4\}/);
  assert.match(phone, /setCacheDisabled",\{cacheDisabled:true\}/, "each sample stays a cold HTTP cache load");
  assert.match(phone, /latency:150,downloadThroughput:1600000\/8/);
});

test("the mobile render coverage and strict thresholds stay unchanged", () => {
  assert.match(runner, /for\(let sample=1;sample<=3;sample\+\+\)/);
  assert.match(runner, /for\(let interaction=0;interaction<3;interaction\+\+\)/);
  assert.match(runner, /before\.lcp<2500/);
  assert.match(runner, /before\.cls<0\.1/);
  assert.match(runner, /interactionMs<200/);
  assert.match(runner, /Object\.values\(result\.targets\)\.some\(value=>!value\)/);
});
