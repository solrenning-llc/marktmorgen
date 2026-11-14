/**
 * "Cancel" on a second-tier approval gives the focus back to the button that opened it (independent review of #3485 at
 * a7f51eb6a3, Claude 1 cloud, MEDIUM 2; WCAG 2.4.3).
 *
 * The opener was drawn in a ternary, so opening the confirmation took it off the page and Cancel drew a new one; the
 * focus went to the node kept from the press, no longer on the page, and so to the page body. Here each host button
 * the component returns gets a stand-in node through its ref, a new one each time it is drawn again after being taken
 * off, as React does; a node whose button left the tree is no longer on the page.
 * Real component (through tests/client-hooks.ts); nothing is sent.
 */
import { AffiliateUnconfirmed, type WaitingLine } from "@/components/affiliate-unconfirmed";
import { find, mount, texts } from "./client-hooks";
import { done, is, part } from "./check";

type Fake = { name: string; connected: boolean; focus: () => void };
let focused: Fake | null = null;
let made = 0;
type Host = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

/** The stand-in node of each button now in the tree, by its words; a button that left the tree loses its node. */
const nodes = new Map<string, Fake>();
function attach(tree: unknown): void {
  const buttons = find(tree, (n) => n.type === "button");
  const now = new Set<string>();
  for (const button of buttons as Host[]) {
    const name = texts(button.props?.children).join("").trim();
    now.add(name);
    let node = nodes.get(name);
    if (!node) {
      made += 1;
      const fresh: Fake = { name: `${name}#${made}`, connected: true, focus: () => { focused = fresh; } };
      node = fresh;
      nodes.set(name, node);
    }
    const ref = button.props?.ref as ((n: unknown) => void) | { current: unknown } | undefined;
    if (typeof ref === "function") ref(node);
    else if (ref && typeof ref === "object") ref.current = node;
  }
  for (const [name, node] of nodes) {
    if (!now.has(name)) {
      node.connected = false;
      nodes.delete(name);
    }
  }
}
const button = (tree: unknown, words: string) => (find(tree, (n) => n.type === "button" && texts(n.props?.children).join("").trim() === words) as Host[])[0];
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

async function main(): Promise<void> {
  const line: WaitingLine = { ref: "s:cs_test_focus0001", at: 1_794_200_000, title: "Course 1", aff: "a1", base: 4900, rate: 5, commission: 245, currency: "usd" };
  const view = await mount(AffiliateUnconfirmed as never, { lines: [line], total: 1, who: { a1: "Ana" }, days: 7 } as never, { beforeEffects: attach });

  part("MEDIUM 2: Cancel gives the focus back to the button that opened the confirmation");
  const opener = button(view.tree(), "Review and approve");
  is("the opener is drawn", Boolean(opener), true);
  const openerNode = nodes.get("Review and approve")!;
  (opener.props!.onClick as (e: unknown) => void)({ currentTarget: openerNode });
  await view.settle();
  is("the confirmation is open and takes the focus", focused?.name.startsWith("Yes, approve it") ?? false, true);
  const cancel = button(view.tree(), "Cancel");
  (cancel.props!.onClick as (e: unknown) => void)({ currentTarget: nodes.get("Cancel") });
  await view.settle();
  await wait();
  is("after Cancel, the focus is on a button that is on the page", focused?.connected ?? false, true);
  is("and it is the button that opens the confirmation", focused?.name.startsWith("Review and approve") ?? false, true);
  view.unmount();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
