/**
 * The WebKit leave guard of tests/e2e/store-copy.mjs (#4844) drops a same-origin RSC fetch failure only when the page
 * really leaves (Codex V's MEDIUM on #4844, C1-20261117-2340-todos-1 item 2). beforeunload can be canceled: a fetch
 * that failed after a leave the page refused must still reach "no page threw" once the harness says the document
 * stayed; pagehide confirms the leave, pageshow restores reporting, and any other failure throws at once. No clock
 * decides it: a navigation whose new document takes longer than any fixed grace to arrive still drops the cut-off
 * fetch (21 November 2026, the merge-queue run of #3774: the new document took 1.1 s and the old guard threw at 1 s).
 *
 * The test runs the browser initializer itself, cut from the e2e file, in node:vm with a synthetic fetch, events and
 * timers: no browser, network or real page. The harness side (what says "stayed") is checked in the source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync("tests/e2e/store-copy.mjs", "utf8");
const prefix = "await context.addInitScript(";
const first = source.indexOf(`${prefix}() => {\n      window.__mmNavigationRsc`);
const last = source.indexOf("\n    });\n    const newPage", first);
const initialize = source.slice(first + prefix.length, last + "\n    }".length);
const origin = "https://example.test";
const failed = new TypeError("synthetic fetch failure");
const idle = () => new Promise((resolve) => setImmediate(resolve));

type Page = { window: { fetch: (input: string) => Promise<unknown>; __mmNavigationRsc?: { done: boolean }[]; __mmStayed?: () => void }; fire: (name: string) => void; advance: () => void };

function environment(): Page {
  const events = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const window = { async fetch(): Promise<unknown> { throw failed; } } as Page["window"];
  runInNewContext(`(${initialize})()`, {
    URL,
    location: { origin, href: `${origin}/studio` },
    window,
    addEventListener(name: string, handler: () => void) { events.set(name, handler); },
    setTimeout(callback: () => void) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return {
    window,
    fire(name) { events.get(name)?.(); },
    advance() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
  };
}

function observe(promise: Promise<unknown>): () => unknown {
  let result: unknown = "pending";
  void promise.then(() => { result = "fulfilled"; }, (error) => { result = error; });
  return () => result;
}

test("the browser initializer is found in tests/e2e/store-copy.mjs", () => {
  assert.ok(first >= 0 && last > first, "the browser initializer was located");
});

test("a canceled leave still reports a fetch failure once the harness says the document stayed", async () => {
  const page = environment();
  page.fire("beforeunload");
  const result = observe(page.window.fetch("/studio?_rsc=synthetic"));
  await idle();
  assert.equal(result(), "pending");
  assert.equal(typeof page.window.__mmStayed, "function", "the harness can say the document stayed");
  page.window.__mmStayed?.();
  await idle();
  assert.equal(result(), failed);
});

test("a leave whose new document takes longer than any clock still drops the cut-off fetch", async () => {
  const page = environment();
  page.fire("beforeunload");
  const result = observe(page.window.fetch("/studio?_rsc=synthetic"));
  await idle();
  page.advance();
  await idle();
  assert.equal(result(), "pending", "no timer decides that the document stayed");
  page.fire("pagehide");
  await idle();
  assert.equal(result(), "pending");
  assert.equal(page.window.__mmNavigationRsc?.[0]?.done, true);
});

test("the harness says \"stayed\" where it knows it: a failed goto or reload and the sweep before \"no page threw\", never a failed navigation request", () => {
  const harness = source.slice(last);
  assert.match(harness, /const stayed = \(\) => page\.isClosed\(\) \? Promise\.resolve\(\) : page\.evaluate\(\(\) => window\.__mmStayed\?\.\(\)\)/);
  assert.match(harness, /catch \(error\) \{ await stayed\(\); throw error; \}/);
  assert.match(harness, /if \(response === null\) await stayed\(\);/);
  assert.match(harness, /page\.goto=async \(\.\.\.args\)=>\{await settle\(\);return navigated\(\(\)=>goto\(\.\.\.args\)\);\};/);
  assert.match(harness, /page\.reload=async \(\.\.\.args\)=>\{await settle\(\);return navigated\(\(\)=>reload\(\.\.\.args\)\);\};/);
  assert.doesNotMatch(harness, /requestfailed/, "a navigation a newer one replaced also fails its request while the page leaves");
  const sweep = harness.indexOf("window.__mmStayed?.(); return new Promise((resolve) => setTimeout(resolve, 0));");
  const verdict = harness.indexOf('is("no page threw", errors, []);');
  assert.ok(sweep >= 0 && verdict > sweep, "every open page is told it stayed right before the verdict");
  assert.doesNotMatch(initialize, /setTimeout|leaveTimer/, "the initializer keeps no clock");
});

test("pagehide confirms a cut-off fetch, and pageshow restores error reporting", async () => {
  const page = environment();
  page.fire("beforeunload");
  const result = observe(page.window.fetch("/studio?_rsc=synthetic"));
  await idle();
  page.fire("pagehide");
  page.advance();
  await idle();
  assert.equal(result(), "pending");
  assert.equal(page.window.__mmNavigationRsc?.[0]?.done, true);
  page.fire("pageshow");
  await assert.rejects(page.window.fetch("/studio?_rsc=restored"), (error) => error === failed);
});

test("other failures still throw at once, without waiting for the leave to be decided", async () => {
  const page = environment();
  page.fire("beforeunload");
  await assert.rejects(page.window.fetch("/studio"), (error) => error === failed);
  await assert.rejects(page.window.fetch("https://example.org/?_rsc=synthetic"), (error) => error === failed);
});
