/**
 * Stands in for React in tests/quiet-moment.test.ts (tests/aliases/quiet-moment.test.ts.json), for a component that
 * draws nothing and does its work in effects (components/store-beacon.tsx). Mounting runs the component and its
 * effects; the unmount it returns runs their cleanups, as React does when a soft navigation leaves the page.
 */
type Effect = () => void | (() => void);

let collecting: Effect[] | null = null;

export function useEffect(effect: Effect, _deps?: unknown[]): void {
  if (!collecting) throw new Error("useEffect called outside mount()");
  collecting.push(effect);
}

/** Runs the component and its effects; the function returned is its unmount. */
export function mount<P>(component: (props: P) => unknown, props: P): () => void {
  collecting = [];
  component(props);
  const effects = collecting;
  collecting = null;
  const cleanups = effects.map((effect) => effect());
  return () => cleanups.forEach((cleanup) => typeof cleanup === "function" && cleanup());
}
