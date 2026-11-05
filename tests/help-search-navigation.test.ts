/** Real HelpSearch handlers with a small DOM/hook fixture; browser proof is in the public matrix. */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import { done, is, part } from "./check";

type Node = { type: string; props: { children?: Node | Node[]; value?: string; onChange?: (event: { target: { value: string } }) => void } };
class HelpSection {
  hidden = false;
  constructor(public id: string, public items: HelpAnswer[]) {}
  querySelector() { return this.items.find(item => !item.hidden) ?? null; }
  matches(selector: string) { return selector.includes("section[data-help-section]"); }
  scrolls = 0;
  scrollIntoView() { this.scrolls++; }
}
class HelpAnswer {
  hidden = false;
  open = false;
  scrolls = 0;
  constructor(public id: string, public textContent: string) {}
  matches(selector: string) { return selector.includes("details[data-help-item]"); }
  scrollIntoView() { this.scrolls++; }
}
class HelpLink {
  constructor(public href: string, public target = "", public download = false) {}
  closest() { return this; }
  getAttribute(name: string) { return name === "href" ? this.href : name === "target" ? this.target : null; }
  hasAttribute(name: string) { return name === "download" && this.download; }
}
const compiled = transpileModule(readFileSync("components/help-search.tsx", "utf8"), {
  compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
}).outputText;

function fixture(hash = "") {
  const answers = [new HelpAnswer("pay", "Pay through Stripe"), new HelpAnswer("course", "Read your course")];
  const sections = answers.map((answer, i) => new HelpSection("section-" + i, [answer]));
  const other = { matches: () => false, scrollIntoView: () => { throw Error("Unrelated anchor was handled"); } };
  const states: unknown[] = [];
  let cursor = 0, mounted = false;
  const effects: (() => void | (() => void))[] = [];
  const listeners = new Map<string, () => void>();
  const hooks = {
    useState(initial: unknown) {
      const slot = cursor++;
      if (!(slot in states)) states[slot] = initial;
      return [states[slot], (value: unknown) => { states[slot] = value; }];
    },
    useId: () => "help-hint",
    useEffect: (effect: () => void | (() => void)) => { if (!mounted) effects.push(effect); },
  };
  const exports: { HelpSearch?: () => Node } = {};
  const window = {
    location: { hash },
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
    removeEventListener: (name: string, handler: () => void) => { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  runInNewContext(compiled, {
    exports, window, HTMLDetailsElement: HelpAnswer, Element: HelpLink,
    document: {
      addEventListener: window.addEventListener,
      removeEventListener: window.removeEventListener,
      getElementById: (id: string) => [...answers, ...sections].find(item => item.id === id) ?? (id === "unrelated" ? other : null),
      querySelectorAll: (selector: string) => selector === "details[data-help-item]" ? answers : sections,
    },
    require: (name: string) => {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") {
        const jsx = (type: string, props: Node["props"]) => ({ type, props });
        return { jsx, jsxs: jsx };
      }
      throw Error("Unexpected dependency " + name);
    },
  });
  function render() { cursor = 0; return exports.HelpSearch!(); }
  function find(node: Node, type: string): Node | undefined {
    if (node?.type === type) return node;
    const children = node?.props?.children;
    for (const child of (Array.isArray(children) ? children : [children]).flat()) {
      if (child && typeof child === "object") { const found = find(child, type); if (found) return found; }
    }
  }
  render(); mounted = true;
  const cleanup = effects.map(effect => effect());
  return {
    answers, sections, listeners,
    search(value: string) { find(render(), "input")!.props.onChange!({ target: { value } }); },
    value: () => find(render(), "input")!.props.value,
    shown: () => states[1],
    navigate(hash: string) { window.location.hash = hash; listeners.get("hashchange")?.(); },
    follow(href: string, options: { target?: string; download?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean; button?: number } = {}) {
      const { target, download, ...eventOptions } = options;
      (listeners.get("click") as ((event: unknown) => void) | undefined)?.({ target: new HelpLink(href, target, download), button: 0, defaultPrevented: false, ...eventOptions });
    },
    close() { for (const stop of cleanup) if (typeof stop === "function") stop(); },
  };
}

part("A help answer fragment clears a filter that hid its answer and section");
{
  const f = fixture(); f.search("Stripe");
  is("the course really is hidden by search", [f.answers[1].hidden, f.sections[1].hidden, f.shown()], [true, true, 1]);
  f.navigate("#course");
  is("the answer and its section are visible, open, and scrolled to", [f.answers[1].hidden, f.sections[1].hidden, f.answers[1].open, f.answers[1].scrolls], [false, false, true, 1]);
  is("the controlled input and result message agree with the cleared filter", [f.value(), f.shown()], ["", null]);
  f.search("course");
  is("search keeps working after navigation", [f.value(), f.shown(), f.answers.map(item => item.hidden)], ["course", 1, [true, false]]);
  f.close(); is("unmount removes the same hash listener", f.listeners.size, 0);
}

part("A real help section fragment is also reachable after no results");
{
  const f = fixture(); f.search("no-match"); f.navigate("#section-1");
  is("section navigation restores the list and search state", [f.sections.map(item => item.hidden), f.answers.map(item => item.hidden), f.value(), f.shown(), f.sections[1].scrolls], [[false, false], [false, false], "", null, 1]);
  f.close();
}

part("Following the current fragment again does not need a hashchange event");
for (const hash of ["#course", "#section-1"]) {
  const f = fixture(hash); f.search("no-match"); f.follow(hash);
  is("same fragment reveals the target " + hash, [f.value(), f.shown(), f.answers[1].hidden, f.sections[1].hidden], ["", null, false, false]);
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }, { button: 1 }, { target: "_blank" }, { download: true }]) {
    f.search("Stripe"); f.follow(hash, options);
    is("modified or separately targeted links keep the current page " + hash + JSON.stringify(options), f.value(), "Stripe");
  }
  f.close(); is("both navigation listeners removed " + hash, f.listeners.size, 0);
}

part("Malformed and unrelated fragments never break search or erase a query");
for (const hash of ["#%", "#%E0%A4%A", "#missing", "#unrelated", ""]) {
  const f = fixture(); f.search("Stripe");
  let threw = false; try { f.navigate(hash); } catch { threw = true; }
  is("harmless fragment " + hash, [threw, f.value(), f.shown(), f.answers[1].hidden], [false, "Stripe", 1, true]);
  f.navigate("#%63ourse");
  is("a later encoded answer link still opens " + hash, [f.answers[1].hidden, f.answers[1].open, f.value()], [false, true, ""]);
  f.close();
}
part("Initial answer links still open; malformed entry URLs remain usable");
{
  const initial = fixture("#course"); is("initial answer open", [initial.answers[1].open, initial.answers[1].scrolls], [true, 1]); initial.close();
  let f: ReturnType<typeof fixture> | undefined, threw = false;
  try { f = fixture("#%"); } catch { threw = true; }
  is("malformed entry URL does not throw", threw, false);
  if (f) { f.search("Stripe"); is("search usable after malformed entry", f.shown(), 1); f.close(); }
}
done();
