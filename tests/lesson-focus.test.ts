/**
 * "Focus mode" on a lesson's page (295 [SQ6]; components/lesson-focus.tsx;
 * added 12 November 2026). Checked with the real component, the real words
 * in every buyer language, the real lesson page's code and the real CSS:
 *
 *   - before scripts run, no button is offered and nothing is hidden;
 *   - one press hides what is around the lesson, says so to a screen reader,
 *     and the same button then says how to leave; a second press brings it
 *     all back; the choice is kept in this browser, and still works for the
 *     visit when the browser refuses to keep it;
 *   - every buyer language has its own four phrases;
 *   - on the lesson page, the trail, the outline, the notes, the comments and
 *     the links to the lessons before and after are what it hides, never the
 *     lesson, its player or "Mark as done";
 *   - the compiled CSS really hides them, and nothing is animated.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FOCUS_KEY, LessonFocus, setFocus } from "@/components/lesson-focus";
import { COURSES_WORDS } from "@/lib/buyer-words/courses";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

const words = { focusOn: COURSES_WORDS.en.focusOn, focusOff: COURSES_WORDS.en.focusOff, focusOnSaid: COURSES_WORDS.en.focusOnSaid, focusOffSaid: COURSES_WORDS.en.focusOffSaid };
const HIDE = "group-data-[focus=on]/focus:hidden";

type Store = Map<string, string>;
function browser(store: Store | "refuses"): void {
  const listeners: ((e: { key: string }) => void)[] = [];
  const g = globalThis as unknown as { window: unknown };
  g.window = {
    localStorage: {
      getItem: (k: string) => { if (store === "refuses") throw new Error("denied"); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (store === "refuses") throw new Error("denied"); store.set(k, v); },
    },
    addEventListener: (_: string, l: (e: { key: string }) => void) => listeners.push(l),
    removeEventListener: () => {},
  };
}

async function main(): Promise<void> {
  part("Before scripts run");
  {
    const html = renderToStaticMarkup(createElement(LessonFocus, { words }, createElement("p", null, "The lesson")));
    is("no button, nothing hidden, the lesson drawn", [html.includes("<button"), html.includes('data-focus="off"'), html.includes("The lesson")], [false, true, true]);
  }

  part("One press, then another");
  {
    const store: Store = new Map();
    browser(store);
    const shown = await mount(LessonFocus, { words, children: "The lesson" });
    const button = () => find(shown.tree(), (n) => n.type === "button")[0];
    const wrapper = () => find(shown.tree(), (n) => n.props?.["data-focus"] !== undefined)[0];
    const status = () => texts(find(shown.tree(), (n) => n.props?.role === "status")[0]).join("");
    is("offered once scripts run, named for what it does", [texts(button()).join(""), wrapper().props?.["data-focus"], status()], ["Focus mode", "off", ""]);
    (button().props?.onClick as () => void)();
    await shown.settle();
    is("pressed: hidden around the lesson, said, and the same button says how to leave", [wrapper().props?.["data-focus"], status(), texts(button()).join("")], ["on", "Focus mode is on. Only the lesson is shown.", "Leave focus mode"]);
    is("kept in this browser", store.get(FOCUS_KEY), "on");
    (button().props?.onClick as () => void)();
    await shown.settle();
    is("pressed again: all back", [wrapper().props?.["data-focus"], status(), texts(button()).join(""), store.get(FOCUS_KEY)], ["off", "Focus mode is off. The course outline is back.", "Focus mode", "off"]);
    shown.unmount();
  }

  part("The next lesson remembers, and a browser that keeps nothing still works");
  {
    setFocus(true);
    const again = await mount(LessonFocus, { words, children: "Next lesson" });
    is("opened again in focus mode", find(again.tree(), (n) => n.props?.["data-focus"] !== undefined)[0].props?.["data-focus"], "on");
    again.unmount();
    browser("refuses");
    setFocus(false);
    const shown = await mount(LessonFocus, { words, children: "The lesson" });
    (find(shown.tree(), (n) => n.type === "button")[0].props?.onClick as () => void)();
    await shown.settle();
    is("switched on for this visit though nothing could be kept", find(shown.tree(), (n) => n.props?.["data-focus"] !== undefined)[0].props?.["data-focus"], "on");
    shown.unmount();
  }

  part("Every buyer language");
  {
    const keys = ["focusOn", "focusOff", "focusOnSaid", "focusOffSaid"] as const;
    for (const [lang, w] of Object.entries(COURSES_WORDS)) {
      is(`${lang}: four phrases, each its own`, keys.every((k) => typeof w[k] === "string" && w[k].trim().length > 2) && new Set(keys.map((k) => w[k])).size === 4, true);
      if (lang !== "en") is(`${lang}: written in ${lang}, not left in English`, keys.filter((k) => w[k] === COURSES_WORDS.en[k]), []);
    }
  }

  part("On the lesson page");
  {
    const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
    const hiddenAround = (marker: RegExp) => {
      const at = page.search(marker);
      return at >= 0 && page.slice(Math.max(0, at - 260), at + 40).includes(HIDE);
    };
    is("the whole lesson area is inside the focus wrapper", /<LessonFocus words=\{\{ focusOn: w\.focusOn, focusOff: w\.focusOff, focusOnSaid: w\.focusOnSaid, focusOffSaid: w\.focusOffSaid \}\}>[\s\S]*<article[\s\S]*<aside[\s\S]*<LessonComments[\s\S]*<\/LessonFocus>/.test(page), true);
    is("the trail to the course is hidden", hiddenAround(/<Link href=\{base\} className="st-footer-link font-semibold">\{product\.title\}/), true);
    is("the course outline is hidden", /<aside className="[^"]*group-data-\[focus=on\]\/focus:hidden"/.test(page), true);
    is("the notes are hidden", hiddenAround(/<LessonNotes/), true);
    is("the comments are hidden", hiddenAround(/<LessonComments/), true);
    is("the link to the next lesson is hidden", hiddenAround(/\{w\.nextLesson\}/), true);
    is("the link to the lesson before is hidden", hiddenAround(/\{w\.previousLesson\}/), true);
    is("the lesson itself never is", /<article className="[^"]*hidden/.test(page) || /<h1[^>]*hidden/.test(page), false);
    is("the outline's column closes, so the lesson takes the width", page.includes("group-data-[focus=on]/focus:lg:grid-cols-1"), true);
  }

  part("The compiled CSS");
  {
    const { compile } = createRequire(`${process.cwd()}/package.json`)("@tailwindcss/node") as typeof import("@tailwindcss/node");
    const compiler = await compile(readFileSync("app/globals.css", "utf8"), { base: process.cwd(), onDependency() {} });
    const css = compiler.build([HIDE, "group-data-[focus=on]/focus:lg:grid-cols-1", "group/focus"]);
    const rule = css.slice(css.indexOf("group-data-\\[focus\\=on\\]\\/focus\\:hidden"));
    is("hides under a wrapper whose data-focus is on", /:where\(\.group\\\/focus\)\[data-focus="on"\]/.test(rule.slice(0, 400)) && /display: none/.test(rule.slice(0, 400)), true);
    is("closes the outline's column on wide screens", /grid-template-columns: repeat\(1, minmax\(0, 1fr\)\)/.test(css), true);
    const component = readFileSync("components/lesson-focus.tsx", "utf8");
    is("nothing animates", /transition|animate-|duration-/.test(component), false);
  }

  done();
}

void main();
