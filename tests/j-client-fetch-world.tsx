/** Controlled Node hook/effect host. React elements and all product callbacks remain actual; no DOM/hydration claim. */
import * as React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

export type Host = { type: string; props: Record<string, unknown>; children: (Host | string)[] };
type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number };
const internals = (React as typeof React & { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const same = (a?: readonly unknown[], b?: readonly unknown[]) => Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
export const textOf = (node: Host | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

export class ClientWorld {
  private frames = new Map<string, Frame>();
  private contexts = new Map<object, unknown>();
  private active: Frame | null = null;
  private effects: (() => void)[] = [];
  private dirty = false;
  tree: Host = { type: "proof-root", props: {}, children: [] };
  private root: React.ReactNode;
  constructor(child: React.ReactNode) {
    const router = { bfcacheId: "j-client-fetch-proof", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch: async () => {} };
    this.root = React.createElement(AppRouterContext.Provider, { value: router }, child);
  }
  private slot(): Slot {
    if (!this.active) throw new Error("Hook outside the controlled component frame");
    return this.active.slots[this.active.cursor] ?? (this.active.slots[this.active.cursor] = {});
  }
  private state(initial: unknown) {
    const frame = this.active!, index = frame.cursor++, slot = frame.slots[index] ?? (frame.slots[index] = {});
    if (!Object.hasOwn(slot, "value")) slot.value = typeof initial === "function" ? initial() : initial;
    return [slot.value, (update: unknown) => {
      const next = typeof update === "function" ? update(slot.value) : update;
      if (!Object.is(next, slot.value)) { slot.value = next; this.dirty = true; }
    }];
  }
  private effect(work: () => void | (() => void), deps?: readonly unknown[]) {
    const slot = this.slot(); this.active!.cursor++;
    if (!same(slot.deps, deps)) this.effects.push(() => { slot.cleanup?.(); const cleanup = work(); slot.cleanup = typeof cleanup === "function" ? cleanup : undefined; slot.deps = deps; });
  }
  private memo(work: () => unknown, deps?: readonly unknown[]) {
    const slot = this.slot(); this.active!.cursor++;
    if (!Object.hasOwn(slot, "value") || !same(slot.deps, deps)) { slot.value = work(); slot.deps = deps; }
    return slot.value;
  }
  private dispatcher() {
    return {
      useState: (value: unknown) => this.state(value),
      useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown, init?: (v: unknown) => unknown) => {
        const [value, set] = this.state(init ? () => init(initial) : initial) as [unknown, (v: unknown) => void];
        return [value, (action: unknown) => set((prior: unknown) => reducer(prior, action))];
      },
      useRef: (value: unknown) => this.memo(() => ({ current: value }), []),
      useContext: (context: object & { _currentValue?: unknown }) => this.contexts.has(context) ? this.contexts.get(context) : context._currentValue,
      useEffect: (work: () => void | (() => void), deps?: readonly unknown[]) => this.effect(work, deps),
      useLayoutEffect: (work: () => void | (() => void), deps?: readonly unknown[]) => this.effect(work, deps),
      useMemo: (work: () => unknown, deps?: readonly unknown[]) => this.memo(work, deps),
      useCallback: (work: unknown, deps?: readonly unknown[]) => this.memo(() => work, deps),
      useId: () => this.memo(() => `client-proof-${this.frames.size}-${this.active!.cursor}`, []),
      useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
      useDebugValue() {},
    };
  }
  private expand(node: React.ReactNode, path: string): (Host | string)[] {
    if (node == null || typeof node === "boolean") return [];
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return [String(node)];
    if (Array.isArray(node)) return node.flatMap((child, i) => this.expand(child, `${path}.${i}`));
    if (!React.isValidElement(node)) throw new Error("Unsupported React child in the controlled Node host");
    const element = node as React.ReactElement<Record<string, unknown>>, props = element.props;
    const type = element.type as unknown;
    if (typeof type === "string") return [{ type, props, children: this.expand(props.children as React.ReactNode, `${path}.children`) }];
    if (type === React.Fragment) return this.expand(props.children as React.ReactNode, `${path}.fragment`);
    if (type && typeof type === "object" && "_currentValue" in type && Object.hasOwn(props, "value")) {
      const existed = this.contexts.has(type), before = this.contexts.get(type);
      this.contexts.set(type, props.value);
      try { return this.expand(props.children as React.ReactNode, `${path}.provider`); }
      finally { if (existed) this.contexts.set(type, before); else this.contexts.delete(type); }
    }
    if (typeof type !== "function") throw new Error("Unsupported component type in the controlled Node host");
    const key = `${path}:${type.name}:${element.key ?? ""}`;
    const frame = this.frames.get(key) ?? { slots: [], cursor: 0 };
    frame.cursor = 0; this.frames.set(key, frame);
    const prior = this.active, oldDispatcher = internals.H;
    this.active = frame; internals.H = this.dispatcher();
    let output: React.ReactNode;
    try { output = (type as (p: Record<string, unknown>) => React.ReactNode)(props); }
    finally { this.active = prior; internals.H = oldDispatcher; }
    return this.expand(output, `${key}.result`);
  }
  render() {
    for (let pass = 0; pass < 20; pass++) {
      this.dirty = false;
      this.tree = { type: "proof-root", props: {}, children: this.expand(this.root, "root") };
      for (const effect of this.effects.splice(0)) effect();
      if (!this.dirty) return this.tree;
    }
    throw new Error("Controlled render did not settle within 20 passes");
  }
  nodes(predicate: (node: Host) => boolean): Host[] {
    const found: Host[] = [];
    const walk = (node: Host | string) => { if (typeof node === "string") return; if (predicate(node)) found.push(node); node.children.forEach(walk); };
    walk(this.tree); return found;
  }
  one(predicate: (node: Host) => boolean) {
    const found = this.nodes(predicate);
    if (found.length !== 1) throw new Error(`Expected one actual host control, found ${found.length}`);
    return found[0];
  }
  button(label: string) { return this.one(node => node.type === "button" && textOf(node) === label); }
  async invoke(node: Host, name: string, event: unknown = {}) {
    const handler = node.props[name];
    if (typeof handler !== "function") throw new Error(`Actual control has no ${name} callback`);
    await handler(event); this.render();
  }
  text() { return textOf(this.tree); }
  dispose() { for (const frame of this.frames.values()) for (const slot of frame.slots) slot.cleanup?.(); this.frames.clear(); }
}

/** Bounded controlled timers run the real debounce callbacks, without real waits or browser claims. */
export class ControlledTimers {
  private next = 0;
  private queue = new Map<number, { work: (...args: unknown[]) => unknown; args: unknown[] }>();
  private oldSet = globalThis.setTimeout;
  private oldClear = globalThis.clearTimeout;
  install() {
    const target = globalThis as unknown as { setTimeout: (work: (...args: unknown[]) => unknown, delay?: number, ...args: unknown[]) => number; clearTimeout: (id: number) => void };
    target.setTimeout = (work, _delay, ...args) => { const id = ++this.next; this.queue.set(id, { work, args }); return id; };
    target.clearTimeout = id => { this.queue.delete(Number(id)); };
  }
  async runNext() {
    const next = this.queue.entries().next().value;
    if (!next) throw new Error("No actual component debounce was scheduled");
    const [id, task] = next; this.queue.delete(id); await task.work(...task.args);
  }
  restore() { globalThis.setTimeout = this.oldSet; globalThis.clearTimeout = this.oldClear; this.queue.clear(); }
}
