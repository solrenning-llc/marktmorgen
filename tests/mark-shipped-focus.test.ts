/**
 * Board #5285, row #2544 (a Codex PR whose findings stayed open when it merged; released by Claude 3, taken by Claude 5
 * Jt9). The note (WCAG 2.4.3): after "Mark as shipped" succeeds, the form is replaced by the status region and the focus
 * was left on a button that no longer exists. Now the focus moves to the status region, and only after a press: a page
 * that opens on an order already shipped does not take the focus.
 */
import { MarkShipped } from "@/components/mark-shipped";
import { mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
const find = (node: unknown, match: (n: Node) => boolean): Node | null => {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  const n = node as Node;
  if (match(n)) return n;
  return find(n.props?.children, match);
};

const at = Math.floor(Date.UTC(2026, 10, 23) / 1000);
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, emailed: false, shipped: { at, tracking: "" } } };
globalThis.fetch = (async () => new Response(JSON.stringify(answer.body), { status: answer.status })) as typeof fetch;

async function main(): Promise<void> {
  const focused: string[] = [];
  const attach = (node: { type?: unknown; props?: Record<string, unknown> }) => ({ focus: () => focused.push(`${String(node.type)}:${String(node.props?.role ?? "")}`) });
  const props = { session: "cs_test_focusafterpress01", to: null, shipped: null };

  part("A confirmed press moves the focus to the status region that replaces the form");
  const view = await mount(MarkShipped as (p: typeof props) => unknown, props, undefined, { attach });
  await view.settle();
  const form = find(view.tree(), (n) => n.type === "form");
  is("set-up: the form is drawn", Boolean(form), true);
  await (form!.props!.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
  await view.settle();
  const region = find(view.tree(), (n) => n.type === "div" && n.props?.role === "status");
  is("the status region is drawn", Boolean(region), true);
  is("it can take the focus without joining the tab order", region?.props?.tabIndex, -1);
  is("the focus moved to it, once", focused, ["div:status"]);
  view.unmount();

  part("A refused press keeps the form and the focus where it was");
  focused.length = 0;
  answer = { status: 502, body: { ok: false, error: "stripe" } };
  const refused = await mount(MarkShipped as (p: typeof props) => unknown, props, undefined, { attach });
  await refused.settle();
  const again = find(refused.tree(), (n) => n.type === "form");
  await (again!.props!.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
  await refused.settle();
  is("the form is still there", Boolean(find(refused.tree(), (n) => n.type === "form")), true);
  is("nothing took the focus", focused, []);
  refused.unmount();

  part("An order already shipped when the page opens does not take the focus");
  focused.length = 0;
  const opened = await mount(MarkShipped as (p: typeof props) => unknown, { ...props, shipped: { at, tracking: "" } } as unknown as typeof props, undefined, { attach });
  await opened.settle();
  is("the status region is drawn", Boolean(find(opened.tree(), (n) => n.type === "div" && n.props?.role === "status")), true);
  is("but the focus is left where the person is", focused, []);
  opened.unmount();

  done();
}

void main();
