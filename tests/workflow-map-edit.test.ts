/**
 * A workflow's map opens a step in the editor (391 [CX2], unit 2; added 12
 * November 2026). Real components (components/workflow-tools.tsx WorkflowMap,
 * components/workflow-diagram.tsx), rendered with React's own server renderer
 * and run with tests/client-hooks.ts; the Email studio's wiring read from its
 * source, since it is one 3,000-line component. Checked:
 *
 *   - each step of the list has an "Edit step N" button with its own id, and
 *     pressing it asks for that step;
 *   - a click on a step's box asks for the same step; the End box opens
 *     nothing; the picture stays one image to assistive technology;
 *   - while another sequence is open, or the page is locked, the buttons are
 *     disabled and the boxes open nothing;
 *   - without `onEdit` the map is as before: no button, no click;
 *   - the studio opens the editor at that step, focuses the step (named by
 *     its own title, with a visible ring), and gives the focus back to the
 *     step's button when the editor closes.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { type FocusDoc, WorkflowMap, editorFocusPhase, focusBack, mapEditId } from "@/components/workflow-tools";
import { WorkflowDiagram } from "@/components/workflow-diagram";
import { flowMapLayout } from "@/lib/flow-map";
import type { StepCondition } from "@/lib/flow-rules";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

const tagged = { if: "tagged", tag: "vip" } as unknown as StepCondition;
const steps = [
  { id: "a", subject: "Welcome" },
  { id: "b", when: tagged, otherwise: "end" as const, subject: "For VIPs" },
  { id: "c", subject: "Last one" },
];
const conditionText = () => "they have the label “vip”";

async function main(): Promise<void> {
  part("The list's buttons");
  {
    const asked: number[] = [];
    const tree = WorkflowMap({ steps, conditionText, flowId: "f1", onEdit: (i) => asked.push(i) });
    const buttons = find(tree, (n) => n.type === "button");
    is("one button per step, each named for its step", buttons.map((b) => texts(b).join("")), ["Edit step 1", "Edit step 2", "Edit step 3"]);
    is("each has its own id, for the focus to come back to", buttons.map((b) => b.props?.id), [mapEditId("f1", "a"), mapEditId("f1", "b"), mapEditId("f1", "c")]);
    (buttons[1].props?.onClick as () => void)();
    is("pressing one asks for its step", asked, [1]);
    const html = renderToStaticMarkup(createElement(WorkflowMap, { steps, conditionText, flowId: "f1", onEdit: () => {} }));
    is("rendered as real buttons, 44 px tall at least", (html.match(/<button type="button" id="flow-map-edit-f1-[abc]" class="[^"]*min-h-11 min-w-11/g) ?? []).length, 3);
  }

  part("The picture's boxes");
  {
    const asked: number[] = [];
    const layout = flowMapLayout(steps, ["1. Email “Welcome”", "2. If they have the label “vip”: Email “For VIPs”", "3. Email “Last one”"]);
    const shown = await mount(WorkflowDiagram, { layout, steps: 3, onBox: (i: number) => asked.push(i) });
    const boxes = find(shown.tree(), (n) => n.type === "g" && n.props?.["data-step-box"] !== undefined);
    is("a box for each step, none for the end", boxes.map((b) => b.props?.["data-step-box"]), [0, 1, 2]);
    (boxes[2].props?.onClick as () => void)();
    is("a click on a box asks for its step", asked, [2]);
    const end = find(shown.tree(), (n) => n.type === "g" && n.props?.["data-step-box"] === undefined && Boolean(find(n, (c) => c.type === "rect").length));
    is("the End box opens nothing", end.map((g) => typeof g.props?.onClick), ["undefined"]);
    const svg = find(shown.tree(), (n) => n.type === "svg")[0];
    is("the picture is still one named image", [svg.props?.role, typeof svg.props?.["aria-labelledby"]], ["img", "string"]);
    is("its name says the list has the Edit buttons", texts(find(shown.tree(), (n) => n.type === "title")[0]).join(""), "Picture of the 3 steps and where each one leads. The same steps are listed after it, each with its Edit button.");
    const rects = find(shown.tree(), (n) => n.type === "rect").map((r) => r.props?.fill);
    is("a step's box is painted, so a click inside its words lands on it; the end is not", rects, ["transparent", "transparent", "transparent", "none"]);
  }

  part("Disabled while it cannot open");
  {
    const asked: number[] = [];
    const tree = WorkflowMap({ steps, conditionText, flowId: "f1", onEdit: (i) => asked.push(i), editDisabled: true });
    const buttons = find(tree, (n) => n.type === "button");
    is("the buttons are disabled", buttons.map((b) => b.props?.disabled), [true, true, true]);
    const diagram = find(tree, (n) => n.type === WorkflowDiagram)[0];
    is("the boxes are given nothing to open", typeof diagram.props?.onBox, "undefined");
    const plain = WorkflowMap({ steps, conditionText });
    is("without onEdit: no button and no click, as before", [find(plain, (n) => n.type === "button").length, typeof find(plain, (n) => n.type === WorkflowDiagram)[0].props?.onBox], [0, "undefined"]);
  }

  part("The studio opens the editor at that step");
  {
    const studio = readFileSync("components/email-studio.tsx", "utf8");
    const wiring = studio.slice(studio.indexOf("<WorkflowMap"), studio.indexOf("/>", studio.indexOf("<WorkflowMap")));
    is("the map gets the sequence, its lock and a way to open it", [/flowId=\{f\.id\}/.test(wiring), /editDisabled=\{locked \|\| draft !== null\}/.test(wiring), /openAtStep\.current = index;\s*openDraft\(f\);/.test(wiring)], [true, true, true]);
    is("closing gives the focus back to the step's button, by the step's id, with the sequence's Edit button behind it", /opener\.current = mapEditId\(f\.id, f\.steps\[index\]\.id\);\s*openerFallback\.current = openerId\(f\);/.test(wiring), true);
    is("and the editor's closing uses both", /const back = opener\.current;\s*const fallback = openerFallback\.current;[\s\S]{0,120}if \(back\) focusBack\(document, \[back, fallback\]\);/.test(studio), true);
    is("opening focuses that step, and only once", /const step = openAtStep\.current;\s*openAtStep\.current = null;\s*if \(step !== null && document\.getElementById\(`flow-step-\$\{step\}`\)\) document\.getElementById\(`flow-step-\$\{step\}`\)\?\.focus\(\);\s*else if \(opener\.current\) document\.getElementById\("flow-name"\)\?\.focus\(\);/.test(studio), true);
    const item = studio.match(/<li key=\{s\.editorKey\}[^>]*>/)?.[0] ?? "";
    is("each step of the editor can take the focus, is named by its title, and shows a ring for the keyboard (focus-visible)", [/id=\{`flow-step-\$\{i\}`\}/.test(item), /tabIndex=\{-1\}/.test(item), /aria-labelledby=\{`flow-step-\$\{i\}-title`\}/.test(item), /focus-visible:\[outline:3px_solid_var\(--focus\)\]/.test(item)], [true, true, true, true]);
    is("the title it is named by exists", /<p id=\{`flow-step-\$\{i\}-title`\}/.test(studio), true);
  }
  part("The focus comes back to the same step, whatever the editor did (review of #4124)");
  {
    const ids = (list: typeof steps) => find(WorkflowMap({ steps: list, conditionText, flowId: "f1", onEdit: () => {} }), (n) => n.type === "button").map((b) => [texts(b).join(""), b.props?.id]);
    const before = ids(steps);
    const after = ids(steps.slice(1));
    is("step c's button keeps its id when an earlier step is removed, though its number changes", [before[2], after[1]], [["Edit step 3", mapEditId("f1", "c")], ["Edit step 2", mapEditId("f1", "c")]]);
    is("and no other step takes c's old place's id", after.some(([, id]) => id === mapEditId("f1", "a")), false);
    // A page with buttons: some present, some hidden (focus does not land), some disabled.
    const page = (els: Record<string, { hidden?: boolean; disabled?: boolean }>) => {
      const doc: FocusDoc & { activeElement: unknown } = { activeElement: null, getElementById: (id) => {
        const spec = els[id];
        if (!spec) return null;
        const el = { disabled: spec.disabled, focus: () => { if (!spec.hidden) doc.activeElement = el; } };
        return el;
      } };
      return doc;
    };
    const editC = mapEditId("f1", "c"), sequence = "flow-edit-f1";
    is("step c still there: its own button", focusBack(page({ [editC]: {}, [sequence]: {} }), [editC, sequence]), editC);
    is("step c deleted in the editor: the sequence's Edit button", focusBack(page({ [sequence]: {} }), [editC, sequence]), sequence);
    is("its map folded (the button cannot take the focus): the sequence's Edit button", focusBack(page({ [editC]: { hidden: true }, [sequence]: {} }), [editC, sequence]), sequence);
    is("a disabled button is passed over", focusBack(page({ [editC]: { disabled: true }, [sequence]: {} }), [editC, sequence]), sequence);
    is("nothing to take it: nothing claimed", focusBack(page({}), [editC, sequence]), null);
  }

  part("After Save the focus waits for the refresh, then comes back (review of #4124)");
  {
    // The editor's life as the studio sees it, one render after another.
    const run = (states: { editing: boolean; locked: boolean }[]) => {
      let wasEditing = false, closing = false;
      return states.map(({ editing, locked }) => {
        const phase = editorFocusPhase({ editing, wasEditing, closing, locked });
        if (phase === "open") wasEditing = true;
        if (phase === "wait") { wasEditing = false; closing = true; }
        if (phase === "restore") { wasEditing = false; closing = false; }
        return phase;
      });
    };
    is("opened, then Save: closed while the sequences refresh (locked), then unlocked: the focus waits, then is given back once", run([{ editing: true, locked: false }, { editing: false, locked: true }, { editing: false, locked: true }, { editing: false, locked: false }, { editing: false, locked: false }]), ["open", "wait", "wait", "restore", "none"]);
    is("closed without a refresh (Close): given back at once", run([{ editing: true, locked: false }, { editing: false, locked: false }]), ["open", "restore"]);
    is("locked while open (AI busy): the focus is not moved again", run([{ editing: true, locked: false }, { editing: true, locked: true }, { editing: true, locked: false }]), ["open", "none", "none"]);
    const studio = readFileSync("components/email-studio.tsx", "utf8");
    is("the studio runs it on both the editor's state and its lock", /editorFocusPhase\(\{ editing, wasEditing: wasEditing\.current, closing: closing\.current, locked \}\)[\s\S]{0,1600}\}, \[editing, locked\]\);/.test(studio), true);
    is("and gives the focus back only in the restore phase", /if \(phase !== "restore"\) return;[\s\S]{0,300}if \(back\) focusBack\(document, \[back, fallback\]\);/.test(studio), true);
    const named = find(WorkflowMap({ steps, conditionText, flowId: "f1", flowName: "Welcome", onEdit: () => {} }), (n) => n.type === "button");
    is("each Edit step button says its sequence to a screen reader, so two sequences' buttons differ", texts(named[0]).join(""), "Edit step 1 of \u201cWelcome\u201d");
  }

  done();
}

void main();
