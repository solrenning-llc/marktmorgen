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
  assert.match(runner, /Object\.values\(result\.targets\)\.some\(value=>!value\)/);
});

test("the browser's first page is an unmeasured warm-up, closed before any sample", () => {
  const warm = runner.indexOf("const warm=await browser.newContext(");
  const closed = runner.indexOf("finally{await warm.close();}", warm);
  const samples = runner.indexOf("for(let sample=1;sample<=3;sample++)");
  assert.ok(warm >= 0 && closed > warm, "one warm-up context, always closed");
  assert.ok(closed < samples, "it ends before the first measured sample");
  const body = runner.slice(warm, closed);
  assert.doesNotMatch(body, /results\.push|MOBILE_RENDER_MEASUREMENT|failed=/,
    "nothing the warm-up sees is recorded or counted");
  assert.doesNotMatch(body, /setCacheDisabled|setCPUThrottlingRate/,
    "it changes no measured condition; each sample still sets its own");
  assert.match(runner.slice(samples), /Network\.setCacheDisabled",\{cacheDisabled:true\}/,
    "every measured sample still runs with the HTTP cache disabled");
});

test("the warm-up visits only the home page, so every other page's first server render is still measured", () => {
  const warm = runner.indexOf("const warm=await browser.newContext(");
  const closed = runner.indexOf("finally{await warm.close();}", warm);
  const body = runner.slice(warm, closed);
  const visits = body.match(/\.goto\(/g) ?? [];
  assert.equal(visits.length, 1, "exactly one navigation in the warm-up");
  assert.match(body, /\.goto\(LOCAL\+"\/",/, "and it is the home page");
  assert.doesNotMatch(body, /productPath|storePath|STORE_PATHS|\/pricing|\/platform\//,
    "a store or product page warmed here would hide its first server render from sample 1");
  assert.doesNotMatch(body, /\bfor\s*\(|\.forEach\(|\.map\(/, "no loop over pages");
});
