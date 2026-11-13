/**
 * A minimal hook runner for tests of client components (from Claude 5's sweep app-6).
 *
 * The repository has no DOM library (no jsdom, no testing-library), and
 * renderToString never runs effects or click handlers. This runner calls one
 * function component directly with React's own hook dispatcher swapped for a
 * small one (useState, useEffect, useRef, useSyncExternalStore, useMemo,
 * useCallback, useId), re-renders it after every state change and runs its
 * effects, so the component's real code decides what the person is shown.
 * Child components are not rendered: the proof reads the host elements and
 * text the component itself returns. Test-only; no product file uses it.
 */
import * as React from "react";

type Slot = { value: unknown; deps?: unknown[]; cleanup?: (() => void) | void };
type Internals = { H: unknown };
const internals = (React as unknown as Record<string, Internals>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export type Mounted = { tree: () => unknown; settle: () => Promise<void>; unmount: () => void };

/** Renders `component(props)`, runs its effects, and re-renders on every state change. */
export async function mount<P>(component: (props: P) => unknown, props: P): Promise<Mounted> {
  const slots: Slot[] = [];
  let index = 0;
  let dirty = false;
  let last: unknown = null;
  const pending: (() => void)[] = [];
  const dispatcher = {
    useState(initial: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: typeof initial === "function" ? (initial as () => unknown)() : initial };
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (v: unknown) => unknown)(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) {
          slots[i].value = value;
          dirty = true;
        }
      };
      return [slots[i].value, set];
    },
    useRef(initial: unknown) {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: { current: initial } };
      return slots[i].value;
    },
    useMemo(make: () => unknown, deps?: unknown[]) {
      const i = index++;
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { value: make(), deps };
      return slots[i].value;
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const i = index++;
      if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { value: fn, deps };
      return slots[i].value;
    },
    useId() {
      return `id-${index++}`;
    },
    useSyncExternalStore(subscribe: (change: () => void) => () => void, snapshot: () => unknown) {
      const i = index++;
      const value = snapshot();
      if (!(i in slots)) slots[i] = { value, cleanup: subscribe(() => { if (!Object.is(snapshot(), slots[i].value)) dirty = true; }) };
      slots[i].value = value;
      return value;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const i = index++;
      const slot = slots[i] as Slot | undefined;
      if (slot && deps && same(slot.deps, deps)) return;
      pending.push(() => {
        slot?.cleanup?.();
        slots[i] = { value: null, deps, cleanup: effect() };
      });
    },
  };
  (dispatcher as Record<string, unknown>).useLayoutEffect = dispatcher.useEffect;
  const render = () => {
    const before = internals.H;
    internals.H = dispatcher;
    try {
      index = 0;
      dirty = false;
      last = component(props);
    } finally {
      internals.H = before;
    }
    while (pending.length) pending.shift()!();
  };
  const settle = async () => {
    for (let round = 0; round < 50; round++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return;
      render();
    }
  };
  render();
  await settle();
  return {
    tree: () => last,
    settle,
    unmount: () => slots.forEach((s) => typeof s?.cleanup === "function" && s.cleanup()),
  };
}

type Node = { type?: unknown; props?: Record<string, unknown> & { children?: unknown } };

/** Every text string in the returned tree, in order. */
export function texts(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  const n = node as Node;
  return n.props ? texts(n.props.children) : [];
}

/** The host elements of the returned tree that pass `test`. */
export function find(node: unknown, test: (n: Node) => boolean): Node[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((c) => find(c, test));
  const n = node as Node;
  return [...(test(n) ? [n] : []), ...find(n.props?.children, test)];
}
