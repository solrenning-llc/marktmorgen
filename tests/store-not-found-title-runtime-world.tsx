import { createElement, type ComponentProps } from "react";

/** Test-only request boundary; the route and buyer dictionaries stay real. */
type StoreFixture = { name: string; handle: string; language: string; currency: string; suspended: boolean; look: { theme: string } };
export const fixture: { asked: string; store: StoreFixture | null; failure: boolean; reads: number } = { asked: "sample", store: null, failure: false, reads: 0 };
const total = { store: 0, headers: 0 };
function admit(kind: keyof typeof total) {
  if (total[kind] >= 100) throw new Error(`not-found fixture ${kind} budget before dispatch`);
  total[kind] += 1;
}
export function resetFixture() {
  fixture.asked = "sample";
  fixture.store = null;
  fixture.failure = false;
  fixture.reads = 0;
}
export const normaliseHandle = (raw: string) => raw;
export async function storeForPage() {
  admit("store");
  fixture.reads += 1;
  if (fixture.failure) throw new Error("synthetic store unavailable");
  return fixture.store;
}
export async function headers() {
  admit("headers");
  return new Headers({ "x-nimbus-store": fixture.asked });
}
export const lookStyle = () => ({});
/** Both boundaries are fixtures: Link preserves its children, the site fallback is a sentinel. */
export default function Boundary(props: ComponentProps<"a">) {
  return props.href ? createElement("a", props, props.children) : createElement("p", null, "Site fallback");
}
