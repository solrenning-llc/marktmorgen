/**
 * Cloud J's MEDIUM on #3723 (WCAG 2.4.3): in the learning paths editor (components/learning-paths-editor.tsx) every
 * action took away the control that held the focus and moved it nowhere, so the focus fell to the page's body. Each
 * now sends it to the control that takes its place:
 *   - "Take out" a course: the "Take out" of the course now in its place, else the path's "Add a course" box;
 *   - "Remove path N": the "Put it back" button;
 *   - "Put it back": the restored path's "Path N" heading (its legend, tabIndex -1).
 * The editor's real code runs under tests/client-hooks.ts; the stand-in document records which element is focused.
 * Synthetic only.
 */
import { LearningPathsEditor } from "@/components/learning-paths-editor";
import { pathsRefusal } from "@/lib/learning-paths-studio";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const focused: string[] = [];
(globalThis as Record<string, unknown>).document = {
  getElementById: (id: string) => ({ id, focus: () => focused.push(id) }),
};
(globalThis as Record<string, unknown>).requestAnimationFrame = (run: () => void) => {
  run();
  return 0;
};

const label = (n: Node) => texts(n.props?.children).join("");
const byLabel = (tree: unknown, aria: string) => find(tree, (n: Node) => n.type === "button" && n.props?.["aria-label"] === aria)[0] as Node | undefined;
const byText = (tree: unknown, text: string) => find(tree, (n: Node) => n.type === "button" && label(n) === text)[0] as Node | undefined;
const press = (node: Node | undefined) => (node?.props?.onClick as (() => void) | undefined)?.();
const idOf = (tree: unknown, match: (n: Node) => boolean) => (find(tree, match)[0] as Node | undefined)?.props?.id;

const courses = [
  { id: "c1", title: "One" },
  { id: "c2", title: "Two" },
  { id: "c3", title: "Three" },
];
const initial = [
  { id: "pathaaaaaaaaaaaa", name: "Start here", courses: ["c1", "c2", "c3"], order: "sequence" as const },
  { id: "pathbbbbbbbbbbbb", name: "Next", courses: ["c2", "c3"], order: "free" as const },
];

async function main(): Promise<void> {
  const box = await mount(LearningPathsEditor as (p: Record<string, unknown>) => unknown, { initial, courses });

  part("Take out a course: the focus goes to the course now in its place");
  focused.length = 0;
  press(byLabel(box.tree(), "Take out: Two"));
  await box.settle();
  const nextOut = idOf(box.tree(), (n) => n.type === "button" && n.props?.["aria-label"] === "Take out: Three");
  is("the course after it now holds the place, and its Take out has an id", typeof nextOut === "string" && nextOut.length > 0, true);
  is("and the focus goes to it, never to the page's body", focused.at(-1), nextOut);

  part("Take out the last course: the focus goes to the path's Add a course box");
  focused.length = 0;
  press(byLabel(box.tree(), "Take out: Three"));
  await box.settle();
  is("the path's Add a course box", focused.at(-1), "path-0-add");

  part("Remove a path: the focus goes to Put it back");
  focused.length = 0;
  press(byText(box.tree(), "Remove path 2"));
  await box.settle();
  const back = idOf(box.tree(), (n) => n.type === "button" && label(n) === "Put it back");
  is("Put it back has an id", typeof back === "string" && back.length > 0, true);
  is("and the focus goes to it", focused.at(-1), back);

  part("Put it back: the focus goes to the restored path's heading");
  focused.length = 0;
  press(byText(box.tree(), "Put it back"));
  await box.settle();
  const legend = find(box.tree(), (n: Node) => n.type === "legend" && label(n) === "Path 2")[0] as Node | undefined;
  is("the heading can take the focus without entering the tab order", [typeof legend?.props?.id, legend?.props?.tabIndex], ["string", -1]);
  is("and the focus goes to it", focused.at(-1), legend?.props?.id);
  box.unmount();

  part("Cloud J's LOW: the order refusal never says the order locks the courses");
  const said = pathsRefusal("order", 0);
  is("it says the path suggests an order, never that courses open in it", [/suggests its courses one after another or in no order/.test(said), /open one after another/.test(said)], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
