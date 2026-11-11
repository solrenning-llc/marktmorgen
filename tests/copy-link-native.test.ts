/** Execute the actual client handler; browser default tab/window behavior is not simulated. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import { done, is, part } from "./check";

type Click = { button: number; defaultPrevented: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault: () => void };
type Anchor = { type: string; props: { href: string; onClick: (event: Click) => Promise<void> } };
const compiled = transpileModule(readFileSync("components/copy-link.tsx", "utf8"), {
  compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText;

function fixture(clipboard: "success" | "failure" | "absent" = "success") {
  const calls: unknown[] = [];
  const location = { origin: "https://example.test", pathname: "/help", hash: "#before" };
  const timers: (() => void)[] = [];
  const exports: { CopyLink?: (props: { id: string }) => Anchor } = {};
  runInNewContext(compiled, {
    exports,
    navigator: clipboard === "absent" ? {} : { clipboard: { writeText: async (text: string) => {
      calls.push(["clipboard", text]);
      if (clipboard === "failure") throw Error("Clipboard denied");
    } } },
    window: {
      location,
      history: { replaceState: (...args: unknown[]) => calls.push(["history", ...args]) },
      setTimeout: (callback: () => void, delay: number) => { calls.push(["timer", delay]); timers.push(callback); },
    },
    require: (name: string) => {
      if (name === "react") return { useState: (value: unknown) => [value, (next: unknown) => calls.push(["copied", next])] };
      if (name === "@/components/icons") return { Icon: "svg" };
      if (name === "react/jsx-runtime") {
        const jsx = (type: string, props: Anchor["props"]) => ({ type, props });
        return { jsx, jsxs: jsx };
      }
      throw Error("Unexpected dependency " + name);
    },
  });
  const anchor = exports.CopyLink!({ id: "answer" });
  return {
    anchor, calls, location, timers,
    async activate(options: Partial<Click> = {}) {
      let prevented = 0;
      await anchor.props.onClick({ button: 0, defaultPrevented: false, preventDefault: () => { prevented++; }, ...options });
      return prevented;
    },
  };
}

async function main() {
  part("Modified answer links leave the browser's chosen navigation alone");
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }, { ctrlKey: true, shiftKey: true }]) {
    const f = fixture();
    const prevented = await f.activate(options);
    is("no cancellation, clipboard, history, feedback or timer for " + JSON.stringify(options), [prevented, f.calls, f.location.hash], [0, [], "#before"]);
    is("a real fragment link remains available " + JSON.stringify(options), [f.anchor.type, f.anchor.props.href], ["a", "#answer"]);
  }
  part("Ordinary mouse or keyboard activation still copies exactly once");
  {
    const f = fixture();
    is("normal activation is handled", await f.activate(), 1);
    is("existing copy and feedback are preserved", f.calls, [["clipboard", "https://example.test/help#answer"], ["history", null, "", "#answer"], ["copied", true], ["timer", 2200]]);
    f.timers[0]();
    is("existing feedback resets when its timer runs", f.calls.at(-1), ["copied", false]);
  }
  part("Fallbacks remain links and never claim the clipboard succeeded");
  {
    const f = fixture("absent");
    is("without clipboard the browser follows the anchor", [await f.activate(), f.calls, f.anchor.props.href], [0, [], "#answer"]);
  }
  {
    const f = fixture("failure");
    is("a denied clipboard falls back to the answer fragment", [await f.activate(), f.location.hash, f.calls], [1, "answer", [["clipboard", "https://example.test/help#answer"]]]);
  }
  done();
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
