/** Explicit synthetic service failures around the actual blog page functions. */
import type { ReactNode } from "react";
import type { Store } from "../lib/store";
import type { Post } from "../lib/store-blog";
export * from "../lib/store";
export * from "../lib/store-blog";
export * from "../lib/traffic";
export * from "../lib/ai";
export * from "../lib/studio-route";

let shop: Store;
let post: Post;
let failure: "list" | "post" | "both" | "absent" | "none" = "none";
export function configure(store: Store, value: Post, mode: typeof failure) { shop = store; post = value; failure = mode; }
export async function storeForPage() { return shop; }
export async function studioView() { return { ok: true, view: { store: shop, role: "owner", stores: [shop], owned: [] } }; }
export function studioPath() { return "/studio/blog"; }
export async function cookies() { return {}; }
export async function headers() { return new Headers(); }
export function notFound(): never { throw new Error("SYNTHETIC_NOT_FOUND"); }
export function redirect(): never { throw new Error("SYNTHETIC_REDIRECT"); }
export function permanentRedirect(): never { throw new Error("SYNTHETIC_REDIRECT"); }
export async function allPosts() { if (failure === "list" || failure === "both") throw new Error("Synthetic list unavailable"); return [post]; }
export async function readPost() { if (failure === "post" || failure === "both") throw new Error("Synthetic post unavailable"); return failure === "absent" ? null : post; }
export async function isResting() { return false; }
export function aiAvailableFor() { return false; }
export async function aiLeft() { throw new Error("AI must not be read in this fixture"); }
export function StudioHeader() { return null; }
export function StoreTracking() { return null; }
export function StudioStorePin({ children }: { children: ReactNode }) { return <>{children}</>; }
export function AiOn({ children }: { children: ReactNode }) { return <>{children}</>; }
export function BlogEditor({ post }: { post: { id: string | null; title: string; body: string } }) {
  return <div data-synthetic-editor="true" data-post-id={post.id ?? "new"} data-post-title={post.title} data-post-body={post.body} />;
}
