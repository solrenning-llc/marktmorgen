import type { Store } from "@/lib/store";

export type Crumb = { label: string; href: string };

export function Breadcrumb(_: { path: Crumb[]; here: string }) {
  return null;
}

export function StudioTrail(_: { store: Pick<Store, "sid">; path?: Crumb[]; here: string }) {
  return null;
}
