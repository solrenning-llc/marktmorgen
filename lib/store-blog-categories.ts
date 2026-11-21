/**
 * Categories of a store's blog, the rules only (557 [BG1], unit 1; added 12
 * November 2026). Pure and import-light; keeping them, the studio's fields,
 * the filter on the blog and the category pages are later units, and none of
 * it shows anywhere yet.
 *
 *   - A blog has at most MAX_CATEGORIES, each with a name and an optional
 *     line about it; a post is in at most MAX_POST_CATEGORIES of them.
 *     What is too long, empty, written as markup or a second category with
 *     the same name is refused and said, never cut or merged.
 *   - A category's address is its name in words with its id at the end, as
 *     a product's (lib/product-slug.ts): nothing has to be unique or stored,
 *     and every address ever shared keeps working after a rename, sent on to
 *     the current one.
 *   - A post's categories are only ids of this blog's categories; one that
 *     is not is refused, never guessed. Removing a category takes it off
 *     every post and changes nothing else on them.
 *   - Only published posts count: a category page lists them newest first,
 *     and a category with none is neither shown in the filter nor put in the
 *     store's sitemap, so no empty page is ever offered to a search engine.
 */
import { slugOf } from "@/lib/product-slug";

export const MAX_CATEGORIES = 20;
export const MAX_POST_CATEGORIES = 3;
export const MAX_CATEGORY_NAME = 40;
export const MAX_CATEGORY_ABOUT = 160;

/** A category's id: eight lowercase letters or digits, made by the caller. */
export const CATEGORY_ID = /^[a-z0-9]{8}$/;

export type BlogCategory = { id: string; name: string; about: string };

export type CategoryProblem = "empty" | "long" | "markup" | "about-long" | "taken" | "full" | "missing" | "shape" | "unknown" | "many";

/** What the studio says for each problem, in plain words. */
export const CATEGORY_PROBLEMS: Record<CategoryProblem, string> = {
  empty: "Give the category a name.",
  long: `Keep a category's name to ${MAX_CATEGORY_NAME} characters or fewer.`,
  markup: "A category's name and description are plain words: take out the < and > signs.",
  "about-long": `Keep the description to ${MAX_CATEGORY_ABOUT} characters or fewer.`,
  taken: "Your blog already has a category with that name.",
  full: `Your blog has ${MAX_CATEGORIES} categories, the most it can have. Remove one to add another.`,
  missing: "That category is not on your blog any more. Reload the page to see the current ones.",
  shape: "Pick the categories from the list.",
  unknown: "One of those categories is not on your blog any more. Pick again from the list.",
  many: `Put a post in up to ${MAX_POST_CATEGORIES} categories.`,
};

const chars = (s: string) => [...s].length;
const plain = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "");
const same = (a: string, b: string) => a.localeCompare(b, "en-US", { sensitivity: "accent" }) === 0;

/** A category's name and line, checked. */
export function cleanCategory(raw: { name?: unknown; about?: unknown }): { ok: true; name: string; about: string } | { ok: false; reason: CategoryProblem } {
  const name = plain(raw.name);
  const about = plain(raw.about);
  if (!name) return { ok: false, reason: "empty" };
  if (/[<>]/.test(name) || /[<>]/.test(about)) return { ok: false, reason: "markup" };
  if (chars(name) > MAX_CATEGORY_NAME) return { ok: false, reason: "long" };
  if (chars(about) > MAX_CATEGORY_ABOUT) return { ok: false, reason: "about-long" };
  return { ok: true, name, about };
}

export type ListResult = { ok: true; list: BlogCategory[] } | { ok: false; reason: CategoryProblem };

/** The list with one more category, at the end. */
export function addCategory(list: readonly BlogCategory[], raw: { name?: unknown; about?: unknown }, id: string): ListResult {
  if (!CATEGORY_ID.test(id) || list.some((c) => c.id === id)) return { ok: false, reason: "shape" };
  if (list.length >= MAX_CATEGORIES) return { ok: false, reason: "full" };
  const clean = cleanCategory(raw);
  if (!clean.ok) return clean;
  if (list.some((c) => same(c.name, clean.name))) return { ok: false, reason: "taken" };
  return { ok: true, list: [...list, { id, name: clean.name, about: clean.about }] };
}

/** The list with one category renamed or redescribed; its id, its place and its posts stay. */
export function editCategory(list: readonly BlogCategory[], id: string, raw: { name?: unknown; about?: unknown }): ListResult {
  const at = list.findIndex((c) => c.id === id);
  if (at < 0) return { ok: false, reason: "missing" };
  const clean = cleanCategory(raw);
  if (!clean.ok) return clean;
  if (list.some((c) => c.id !== id && same(c.name, clean.name))) return { ok: false, reason: "taken" };
  const next = [...list];
  next[at] = { id, name: clean.name, about: clean.about };
  return { ok: true, list: next };
}

/** The list without one category, and every post's categories without it; nothing else on a post changes. */
export function removeCategory<P extends { categories: readonly string[] }>(list: readonly BlogCategory[], id: string, posts: readonly P[]): { list: BlogCategory[]; posts: P[] } {
  return {
    list: list.filter((c) => c.id !== id),
    posts: posts.map((p) => (p.categories.includes(id) ? { ...p, categories: p.categories.filter((c) => c !== id) } : p)),
  };
}

/** A post's categories as the studio sent them: ids of this blog's categories, each once, at most MAX_POST_CATEGORIES. */
export function cleanPostCategories(raw: unknown, list: readonly BlogCategory[]): { ok: true; categories: string[] } | { ok: false; reason: CategoryProblem } {
  if (raw === undefined || raw === null) return { ok: true, categories: [] };
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return { ok: false, reason: "shape" };
  const ids = [...new Set(raw as string[])];
  if (ids.some((id) => !list.some((c) => c.id === id))) return { ok: false, reason: "unknown" };
  if (ids.length > MAX_POST_CATEGORIES) return { ok: false, reason: "many" };
  // In the blog's own order, so the same choice is always kept the same way.
  return { ok: true, categories: list.filter((c) => ids.includes(c.id)).map((c) => c.id) };
}

/** The last part of a category's address: its name in words and its id, or the id alone. */
export function categorySegment(category: { id: string; name: string }): string {
  const words = slugOf(category.name);
  return words ? `${words}-${category.id}` : category.id;
}

/** The category an address names, read off its end, and whether the address is the current one or should be sent on to it. */
export function categoryAt(list: readonly BlogCategory[], segment: string): { category: BlogCategory; current: string; moved: boolean } | null {
  const id = segment.slice(-8);
  if (!CATEGORY_ID.test(id) || (segment.length > 8 && segment[segment.length - 9] !== "-")) return null;
  const category = list.find((c) => c.id === id);
  if (!category) return null;
  const current = categorySegment(category);
  return { category, current, moved: current !== segment };
}

/** A post as the categories need it: when it was published (seconds, 0 for never), whether it is a draft, and its categories. */
export type CategorizedPost = { id: string; draft: boolean; publishedAt: number; categories: readonly string[] };

const published = (p: CategorizedPost, nowSeconds: number) => !p.draft && p.publishedAt > 0 && p.publishedAt <= nowSeconds;

/** The published posts of a category, newest first. */
export function postsIn<P extends CategorizedPost>(categoryId: string, posts: readonly P[], now: number): P[] {
  const at = now / 1000;
  return posts.filter((p) => published(p, at) && p.categories.includes(categoryId)).sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
}

/** The categories with at least one published post, in the blog's order, each with how many: for the filter and the sitemap. */
export function categoriesInUse(list: readonly BlogCategory[], posts: readonly CategorizedPost[], now: number): { category: BlogCategory; posts: number }[] {
  const at = now / 1000;
  return list
    .map((category) => ({ category, posts: posts.filter((p) => published(p, at) && p.categories.includes(category.id)).length }))
    .filter((row) => row.posts > 0);
}

/** A category page's title and description, for the page and for search: its own line, or one made of plain facts. */
export function categoryPageText(category: BlogCategory, storeName: string): { title: string; description: string } {
  const store = storeName.trim() || "this store";
  return {
    title: `${category.name} · ${store} blog`,
    description: category.about || `Posts about ${category.name} on the blog of ${store}.`,
  };
}
