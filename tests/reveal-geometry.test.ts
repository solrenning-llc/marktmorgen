import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import { REVEAL_WATCH } from "@/lib/reveal-scripts";

type Options = { threshold?: number | number[]; rootMargin?: string };

/** The Firefox /help trace has a 9305px section in a 720px viewport. */
function fixture() {
  let options: Options | undefined;
  const shown = new Set<string>();
  const section = { classList: { contains: (name: string) => shown.has(name), add: (name: string) => shown.add(name) },
    getBoundingClientRect: () => ({ top: 1000, height: 9305.25 }) };
  class Observer {
    constructor(_callback: unknown, settings: Options) { options = settings; }
    observe(node: unknown) { assert.equal(node, section); }
    unobserve() {}
    disconnect() {}
  }
  const window = { innerHeight: 720, matchMedia: () => ({ matches: false }), IntersectionObserver: Observer };
  const document = { documentElement: { getAttribute: () => "on", removeAttribute: () => assert.fail("unexpected fallback") },
    querySelectorAll: () => [section] };
  return { Observer, window, document, options: () => options };
}

function tallSectionsAreReachable(options: Options | undefined) {
  assert.ok(options, "the real initializer observed the below-fold section");
  const thresholds = Array.isArray(options.threshold) ? options.threshold : [options.threshold ?? 0];
  // A positive visible fragment must be enough even when the entire viewport
  // is smaller than a fraction of the section. No fixed section-height cap.
  for (const height of [9305.25, 100_000, 1_000_000]) {
    const largestVisibleRatio = (720 * 0.94) / height;
    assert.ok(thresholds.some(value => value <= largestVisibleRatio),
      `${height}px section cannot reach the configured threshold in the real 720px viewport`);
  }
}

test("the initial document reveal can admit arbitrarily tall help sections", () => {
  const f = fixture();
  runInNewContext(REVEAL_WATCH, { document: f.document, window: f.window, IntersectionObserver: f.Observer });
  tallSectionsAreReachable(f.options());
});

test("client navigation uses the same reachable reveal geometry", () => {
  const f = fixture();
  let effect: (() => unknown) | undefined;
  const compiled = transpileModule(readFileSync("components/home-interactive.tsx", "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
  }).outputText;
  const exports: { RevealOnScroll?: () => unknown } = {};
  runInNewContext(compiled, { exports, window: f.window, document: f.document, IntersectionObserver: f.Observer,
    require: (name: string) => {
      if (name === "react") return { useEffect: (callback: () => unknown) => { effect = callback; } };
      if (["react/jsx-runtime", "next/link", "@/components/icons"].includes(name)) return {};
      throw Error("Unexpected dependency " + name);
    } });
  exports.RevealOnScroll!();
  assert.ok(effect);
  effect();
  tallSectionsAreReachable(f.options());
});
