/**
 * Codex X4's first MEDIUM on #3723 (6896202674, confirmed by Claude 6 in 6901099146): while the learning paths editor
 * (components/learning-paths-editor.tsx) waited for its save, every field and button stayed editable, and the answer
 * then put the server's copy over the whole list, so an edit made in between was lost and "Saved" was still said.
 * Now every control that changes the list is disabled while the save is pending (one fieldset), the Save button stays
 * focusable with aria-disabled, the focus goes to it when the save starts (so pressing Enter in a name field does not
 * leave the focus on a control that is about to be disabled), and the status message stays outside, to be read out.
 * The editor's real code runs under tests/client-hooks.ts; fetch is a stand-in held open until the test answers it.
 * Synthetic only.
 */
import { LearningPathsEditor } from "@/components/learning-paths-editor";
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

let answer: (value: Response) => void = () => {};
const sent: string[] = [];
(globalThis as Record<string, unknown>).fetch = (_url: string, init: { body: string }) => {
  sent.push(init.body);
  return new Promise<Response>((resolve) => {
    answer = resolve;
  });
};

const CONTROLS = new Set(["input", "select", "textarea", "button"]);
/** Every control in the returned tree, with whether it or a fieldset around it is disabled. */
function controls(node: unknown, off = false): { node: Node; off: boolean }[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((c) => controls(c, off));
  const n = node as Node;
  const here = off || n.props?.disabled === true && (n.type === "fieldset" || CONTROLS.has(String(n.type)));
  const self = CONTROLS.has(String(n.type)) ? [{ node: n, off: here }] : [];
  return [...self, ...controls(n.props?.children, here)];
}
const label = (n: Node) => (typeof n.props?.["aria-label"] === "string" ? String(n.props["aria-label"]) : texts(n.props?.children).join("") || String(n.props?.id ?? n.props?.type ?? n.type));
const isSave = (n: Node) => n.type === "button" && n.props?.type === "submit";

const courses = [
  { id: "c1", title: "One" },
  { id: "c2", title: "Two" },
  { id: "c3", title: "Three" },
];
const initial = [
  { id: "pathaaaa", name: "Start here", courses: ["c1", "c2"], order: "sequence" as const },
  { id: "pathbbbb", name: "Next", courses: ["c2", "c3"], order: "free" as const },
];

async function main(): Promise<void> {
  const box = await mount(LearningPathsEditor as (p: Record<string, unknown>) => unknown, { initial, courses });

  part("Before the save: everything can be changed");
  const before = controls(box.tree());
  is("the editor draws its controls", before.length > 10, true);
  is("none is disabled except a Move button with nowhere to go", before.filter((c) => c.off).every((c) => /^Move (up|down):/.test(label(c.node))), true);

  part("While the save is pending");
  focused.length = 0;
  const form = find(box.tree(), (n: Node) => n.type === "form")[0] as Node;
  void (form.props?.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
  await box.settle();
  is("one request went out, with the list as it was", [sent.length, (JSON.parse(sent[0]) as { paths: unknown[] }).paths.length], [1, 2]);
  const during = controls(box.tree());
  const editable = during.filter((c) => !isSave(c.node) && !c.off).map((c) => label(c.node));
  is("no field, choice or button that changes the list can be used", editable, []);
  const save = during.find((c) => isSave(c.node));
  is("Save stays focusable (never disabled), says it is busy and says Saving", [save?.off, save?.node.props?.["aria-disabled"], texts(save?.node.props?.children).join("")], [false, true, "Saving…"]);
  is("the focus goes to Save when the save starts, never left on a control being disabled", focused.at(-1), save?.node.props?.id);
  const status = find(box.tree(), (n: Node) => n.props?.role === "status")[0];
  is("the status message is not inside a disabled group", controls(status).length === 0 && status !== undefined, true);

  part("Once the save answers");
  answer(new Response(JSON.stringify({ ok: true, paths: initial }), { status: 200, headers: { "content-type": "application/json" } }));
  await box.settle();
  await box.settle();
  const after = controls(box.tree());
  is("the controls can be used again", after.filter((c) => c.off).every((c) => /^Move (up|down):/.test(label(c.node))), true);
  is("and it says what was saved", texts(find(box.tree(), (n: Node) => n.props?.role === "status")[0]).join(""), "Saved: 2 paths.");
  box.unmount();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
