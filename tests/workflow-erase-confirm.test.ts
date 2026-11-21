/**
 * Erasing a person from every workflow asks first (WCAG 3.3.6, AAA: an
 * action that deletes data can be checked, corrected or confirmed; AGENTS.md
 * AX274 Part A item 4).
 *
 * In a workflow's run history (components/workflow-tools.tsx, WorkflowRuns),
 * "Erase dana@... from every workflow" erased the person's runs, history and
 * waiting steps in all the creator's workflows on one press, with no way
 * back. Now the press asks "Erase ... from every workflow? ... This cannot
 * be undone." with "Yes, erase them" and "Keep them"; only "Yes" sends the
 * erasure. The question takes the focus when it opens, on "Keep them", and
 * "Keep them" gives the focus back to the erase button, which never left
 * the page.
 *
 * The real component runs through tests/client-hooks.ts with a stand-in for
 * the studio's request function, so the component's own handlers decide
 * what is sent. Not checked here: where a real browser puts the focus
 * (the runner has no DOM; the focus calls are read from the source).
 */
import { readFileSync } from "node:fs";
import { WorkflowRuns } from "@/components/workflow-tools";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

const run = { person: "p1", email: "dana@example.test", status: "done", step: -1, note: "", startedAt: 1_800_000_000, updatedAt: 1_800_000_100 };
const sent: string[] = [];
const request = async (payload: Record<string, unknown>) => {
  sent.push(String(payload.action));
  if (payload.action === "flow-runs") return { ok: true, runs: [run] };
  if (payload.action === "flow-run") return { ok: true, run, events: [] };
  if (payload.action === "flow-forget") return { ok: true };
  return { ok: false, error: "unexpected" };
};

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

async function main() {
  const view = await mount(WorkflowRuns as (p: Parameters<typeof WorkflowRuns>[0]) => unknown, { flowId: "f1", steps: [], request });
  const button = (words: RegExp) => find(view.tree(), (n: Node) => n.type === "button" && words.test(texts(n).join(""))) [0] as Node | undefined;
  const press = async (words: RegExp) => {
    const b = button(words);
    if (!b) throw new Error(`no button ${words}`);
    await (b.props?.onClick as () => unknown)();
    await view.settle();
  };
  const all = () => texts(view.tree()).join("");

  part("One press asks; it does not erase");
  await press(/^History$/);
  is("the run's history is open", all().includes("Asked to be deleted?"), true);
  await press(/^Erase dana@example\.test from every workflow$/);
  is("nothing is erased on the first press", sent.includes("flow-forget"), false);
  is("the question names the person and says it cannot be undone", [all().includes("Erase dana@example.test from every workflow?"), all().includes("This cannot be undone.")], [true, true]);
  is("it offers both answers, as 44 px buttons", [button(/^Yes, erase them$/), button(/^Keep them$/)].map((b) => String(b?.props?.className ?? "").includes("btn-sm")), [true, true]);

  part("Keep them");
  await press(/^Keep them$/);
  is("the question closes", all().includes("This cannot be undone."), false);
  is("still nothing erased", sent.includes("flow-forget"), false);
  is("the erase button is still there", Boolean(button(/^Erase dana@example\.test from every workflow$/)), true);

  part("Yes, erase them");
  await press(/^Erase dana@example\.test from every workflow$/);
  await press(/^Yes, erase them$/);
  is("one erasure is sent", sent.filter((a) => a === "flow-forget").length, 1);
  is("the person is gone from the runs, and their history closed", [all().includes("dana@example.test"), all().includes("Asked to be deleted?")], [false, false]);

  part("The focus");
  const source = readFileSync("components/workflow-tools.tsx", "utf8");
  is("the question puts the focus on Keep them when it opens", /if \(erasing\) keepButton\.current\?\.focus\(\)/.test(source), true);
  is("Keep them gives it back to the erase button", /eraseButton\.current\?\.focus\(\)/.test(source), true);
  done();
}

void main();
