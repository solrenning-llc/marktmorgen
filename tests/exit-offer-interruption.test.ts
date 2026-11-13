/**
 * The store's offer for a leaving visitor (components/exit-offer.tsx) is an interruption the visitor did not ask
 * for: it opens a modal dialog, which takes the keyboard focus, when the pointer leaves through the top of the
 * window. WCAG 2.2 asks that an interruption can be postponed or suppressed (2.2.4, AAA) and that the focus is
 * never moved away from what the person is doing without their asking (3.2.5 Change on Request, AAA; 3.2.1 On
 * Focus). 274 [AX1].
 *
 * Found reading the code on 13 November 2026, with the browser audit of the buyer's pages: a buyer typing their
 * address in the buy box, who moves the pointer up to the address bar or a bookmark, had the dialog open over the
 * form and the focus taken out of the field they were filling. The pointer leaving is not a request.
 *
 * What this holds, with the real component through tests/client-hooks.ts (synthetic window, document and dialog;
 * no browser, no network):
 *
 *   - it opens on the pointer leaving through the top, when nothing is being filled in (the feature still works);
 *   - it never opens while the visitor has a field, a box or an editable area focused, and nothing is remembered
 *     then, so the offer is still free to appear later in the visit;
 *   - it stays once per visitor per store (the 30 days it already remembers), which is its suppression;
 *   - it never opens from a pointer that stays inside the window, or on a device with no fine pointer.
 */
import { ExitOffer } from "@/components/exit-offer";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
type Listener = (event: unknown) => void;

type World = {
  opened: () => number;
  kept: () => string | null;
  leave: (event: { relatedTarget: unknown; clientY: number }) => void;
  settled: () => Promise<void>;
  listening: () => boolean;
  focus: (element: unknown) => void;
  close: () => void;
};

/**
 * Mounts the component with a stand-in window and document, runs the few seconds it waits, and hands back the
 * handles the checks need. `stored` is what the browser already remembers for this store.
 */
async function world({ stored = null, fine = true }: { stored?: string | null; fine?: boolean } = {}): Promise<World> {
  const store = new Map<string, string>();
  if (stored !== null) store.set("nl_exit_s", stored);
  const timers: (() => void)[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let opened = 0;
  let active: unknown = null;
  const windowStub = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    matchMedia: (query: string) => ({ matches: query === "(pointer: fine)" ? fine : false }),
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  };
  const documentStub = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
    get activeElement() {
      return active;
    },
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = windowStub;
  globals.document = documentStub;
  const mounted = await mount(ExitOffer as unknown as (props: unknown) => unknown, {
    store: "s",
    title: "The starter guide",
    words: { close: "Close", beforeYouGo: "Before you go" },
    children: null,
  });
  // The dialog element the page would give the ref: what the component calls on it is what a visitor is shown.
  const element = {
    showModal: () => {
      opened += 1;
    },
    close: () => {},
  };
  const dialog = find(mounted.tree(), (n: Node) => n.type === "dialog")[0] as Node | undefined;
  const ref = dialog?.props?.ref as { current: unknown } | undefined;
  if (!ref) throw new Error("the dialog is not in the tree");
  ref.current = element;
  // The few seconds before it is armed at all: a glance is not a visit.
  while (timers.length) timers.shift()!();
  await mounted.settle();
  return {
    opened: () => opened,
    kept: () => store.get("nl_exit_s") ?? null,
    leave: (event) => listeners.get("mouseout")?.forEach((fn) => fn(event)),
    settled: () => mounted.settle(),
    listening: () => Boolean(listeners.get("mouseout")?.size),
    focus: (value) => {
      active = value;
    },
    close: () => element.close(),
  };
}

const field = (tag: string, extra: Record<string, unknown> = {}) => ({ tagName: tag, isContentEditable: false, ...extra });
const UP = { relatedTarget: null, clientY: -1 };

async function main(): Promise<void> {
  part("the offer still works: the pointer leaving through the top opens it, once");
  const plain = await world();
  plain.leave(UP);
  await plain.settled();
  is("it opened", plain.opened(), 1);
  is("and it is remembered, so this visitor is not asked again for 30 days (2.2.4)", typeof plain.kept(), "string");
  plain.leave(UP);
  await plain.settled();
  is("a second move out does not open it again", plain.opened(), 1);

  part("3.2.5 and 2.2.4: it never takes the focus from a visitor who is filling something in");
  for (const [what, element] of [
    ["an address field", field("INPUT")],
    ["a message", field("TEXTAREA")],
    ["a chosen option", field("SELECT")],
    ["a block they are writing in", field("DIV", { isContentEditable: true })],
  ] as const) {
    const typing = await world();
    typing.focus(element);
    typing.leave(UP);
    await typing.settled();
    is(`${what}: nothing opened over it`, typing.opened(), 0);
    is(`${what}: nothing was remembered, so the offer can still come later in the visit`, typing.kept(), null);
    is(`${what}: it is still watching for the pointer leaving`, typing.listening(), true);
    // Once they are done with the field, the same visit may still see it.
    typing.focus(null);
    typing.leave(UP);
    await typing.settled();
    is(`${what}: after they leave the field, it opens as before`, typing.opened(), 1);
  }

  part("what already held: the pointer inside the window, a store already offered, and no fine pointer");
  const inside = await world();
  inside.leave({ relatedTarget: {}, clientY: -1 });
  inside.leave({ relatedTarget: null, clientY: 10 });
  await inside.settled();
  is("a pointer that stays in the page, or leaves sideways, opens nothing", inside.opened(), 0);
  const again = await world({ stored: String(Date.now()) });
  again.leave(UP);
  await again.settled();
  is("a visitor who was offered it in the last 30 days is never asked again", again.opened(), 0);
  const touch = await world({ fine: false });
  touch.leave(UP);
  await touch.settled();
  is("on a phone, where leaving cannot be told from scrolling, it never opens", touch.opened(), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
