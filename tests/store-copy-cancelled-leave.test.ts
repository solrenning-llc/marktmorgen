/**
 * The WebKit leave guard of tests/e2e/store-copy.mjs (#4844) drops a same-origin RSC fetch failure only when the page
 * really leaves (Codex V's MEDIUM on #4844, C1-20261117-2340-todos-1 item 2). beforeunload can be canceled: a fetch
 * that failed in the grace second of a leave the page refused must still reach "no page threw" once the document
 * stays; pagehide confirms the leave, pageshow restores reporting, and any other failure throws at once.
 *
 * The test runs the browser initializer itself, cut from the e2e file, in node:vm with a synthetic fetch, events and
 * timers: no browser, network or real page.
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

type Page = { window: { fetch: (input: string) => Promise<unknown>; __mmNavigationRsc?: { done: boolean }[] }; fire: (name: string) => void; advance: () => void };

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

test("a canceled leave still reports a fetch failure that arrived in its grace second", async () => {
  const page = environment();
  page.fire("beforeunload");
  const result = observe(page.window.fetch("/studio?_rsc=synthetic"));
  await idle();
  page.advance();
  await idle();
  assert.equal(result(), failed);
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
