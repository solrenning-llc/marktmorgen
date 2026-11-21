/**
 * Categories of a store's blog, the rules (lib/store-blog-categories.ts, 557
 * [BG1] unit 1; added 12 November 2026). Checked, with synthetic categories
 * and posts only:
 *
 *   - names and lines are refused, never cut, when empty, too long, written
 *     as markup or a second category with the same name; at most 20;
 *   - a rename keeps the id, the place and the posts, and every old address
 *     still finds the category, marked to be sent on to the current one;
 *   - a post's categories are only this blog's, each once, at most 3;
 *     removing a category takes it off every post and nothing else;
 *   - only published posts count: drafts, never-published and future posts
 *     do not, so a category with none is not offered (filter, sitemap).
 */
import { CATEGORY_PROBLEMS, MAX_CATEGORIES, MAX_CATEGORY_ABOUT, MAX_CATEGORY_NAME, type BlogCategory, type CategorizedPost, addCategory, categoriesInUse, categoryAt, categoryPageText, categorySegment, cleanCategory, cleanPostCategories, editCategory, postsIn, removeCategory } from "@/lib/store-blog-categories";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 12);
const S = NOW / 1000;
const id = (n: number) => `cat${String(n).padStart(5, "0")}`;
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

part("Names are refused, never cut");
is("a name and a line, tidied", cleanCategory({ name: "  Recipes   for  busy  weeks ", about: " Quick\n dinners " }), { ok: true, name: "Recipes for busy weeks", about: "Quick dinners" });
is("no name", reason(cleanCategory({ name: "   " })), "empty");
is(`a name over ${MAX_CATEGORY_NAME} characters`, reason(cleanCategory({ name: "x".repeat(MAX_CATEGORY_NAME + 1) })), "long");
is(`exactly ${MAX_CATEGORY_NAME} is fine, emoji counted as one`, reason(cleanCategory({ name: "🍳".repeat(MAX_CATEGORY_NAME) })), "ok");
is("markup in a name", reason(cleanCategory({ name: "<b>Bold</b>" })), "markup");
is("markup in a line", reason(cleanCategory({ name: "Fine", about: "a <script>" })), "markup");
is(`a line over ${MAX_CATEGORY_ABOUT}`, reason(cleanCategory({ name: "Fine", about: "y".repeat(MAX_CATEGORY_ABOUT + 1) })), "about-long");
is("not a string: no name", reason(cleanCategory({ name: 42 })), "empty");
is("every problem has its words, and none is markup", Object.values(CATEGORY_PROBLEMS).every((w) => w.length > 10 && !/<[a-z/]/i.test(w)), true);

part("The list");
{
  let list: BlogCategory[] = [];
  const first = addCategory(list, { name: "Recipes" }, id(1));
  if (first.ok) list = first.list;
  is("added at the end", list.map((c) => c.name), ["Recipes"]);
  is("the same name in other letters is taken", reason(addCategory(list, { name: "RECIPES" }, id(2))), "taken");
  is("an accent makes a different name", reason(addCategory(list, { name: "Récipes" }, id(2))), "ok");
  is("an id that is not one, or taken, is refused", [reason(addCategory(list, { name: "New" }, "BAD")), reason(addCategory(list, { name: "New" }, id(1)))], ["shape", "shape"]);
  let full: BlogCategory[] = [];
  for (let n = 0; n < MAX_CATEGORIES; n += 1) {
    const r = addCategory(full, { name: `Topic ${n}` }, id(n));
    if (r.ok) full = r.list;
  }
  is(`at most ${MAX_CATEGORIES}`, [full.length, reason(addCategory(full, { name: "One more" }, id(99)))], [MAX_CATEGORIES, "full"]);
  const two = addCategory(list, { name: "Travel" }, id(2));
  if (two.ok) list = two.list;
  const renamed = editCategory(list, id(1), { name: "Weeknight recipes", about: "Fast food at home" });
  is("a rename keeps the id and the place", renamed.ok ? renamed.list.map((c) => `${c.id}:${c.name}`) : renamed.reason, [`${id(1)}:Weeknight recipes`, `${id(2)}:Travel`]);
  is("renaming onto another's name is taken; keeping its own name is fine", [reason(editCategory(list, id(1), { name: "travel" })), reason(editCategory(list, id(2), { name: "Travel", about: "new line" }))], ["taken", "ok"]);
  is("a category that is gone", reason(editCategory(list, id(9), { name: "X" })), "missing");
}

part("Addresses keep working");
{
  const cat: BlogCategory = { id: "abc12345", name: "Weeknight Recipes!", about: "" };
  is("words then id", categorySegment(cat), "weeknight-recipes-abc12345");
  is("a name with no letters it can write keeps the bare id", categorySegment({ id: "abc12345", name: "料理" }), "abc12345");
  const list = [cat];
  is("the current address is the current one", categoryAt(list, "weeknight-recipes-abc12345")?.moved, false);
  is("the address before a rename finds it, to be sent on", categoryAt(list, "recipes-abc12345"), { category: cat, current: "weeknight-recipes-abc12345", moved: true });
  is("the bare id finds it too", categoryAt(list, "abc12345")?.category.id, "abc12345");
  is("an address whose id is glued to a word is not one", categoryAt(list, "recipesabc12345"), null);
  is("a removed category's address finds nothing", categoryAt([], "recipes-abc12345"), null);
}

part("A post's categories");
{
  const list: BlogCategory[] = [1, 2, 3, 4].map((n) => ({ id: id(n), name: `C${n}`, about: "" }));
  is("only this blog's, each once, in the blog's order", cleanPostCategories([id(3), id(1), id(3)], list), { ok: true, categories: [id(1), id(3)] });
  is("none sent: none", cleanPostCategories(undefined, list), { ok: true, categories: [] });
  is("an id not on this blog is refused, not dropped", reason(cleanPostCategories([id(1), id(9)], list)), "unknown");
  is("more than 3 is refused, not cut", reason(cleanPostCategories([id(1), id(2), id(3), id(4)], list)), "many");
  is("not a list", reason(cleanPostCategories("C1", list)), "shape");
  const posts = [
    { id: "p1", title: "Keep me", categories: [id(1), id(2)] },
    { id: "p2", title: "Untouched", categories: [id(3)] },
  ];
  const after = removeCategory(list, id(1), posts);
  is("removing takes it off the list and off every post", [after.list.map((c) => c.id), after.posts.map((p) => p.categories)], [[id(2), id(3), id(4)], [[id(2)], [id(3)]]]);
  is("and nothing else on a post changes", [after.posts[0].title, after.posts[1] === posts[1]], ["Keep me", true]);
}

part("Only published posts count");
{
  const list: BlogCategory[] = [1, 2, 3].map((n) => ({ id: id(n), name: `C${n}`, about: "" }));
  const posts: CategorizedPost[] = [
    { id: "old", draft: false, publishedAt: S - 86_400 * 3, categories: [id(1)] },
    { id: "new", draft: false, publishedAt: S - 60, categories: [id(1), id(2)] },
    { id: "draft", draft: true, publishedAt: S - 100, categories: [id(2), id(3)] },
    { id: "never", draft: false, publishedAt: 0, categories: [id(3)] },
    { id: "later", draft: false, publishedAt: S + 3600, categories: [id(3)] },
  ];
  is("a category's posts, newest first, drafts and future ones left out", postsIn(id(1), posts, NOW).map((p) => p.id), ["new", "old"]);
  is("only categories with a published post, with how many", categoriesInUse(list, posts, NOW).map((r) => `${r.category.id}:${r.posts}`), [`${id(1)}:2`, `${id(2)}:1`]);
  is("a category with only drafts or future posts is not offered", categoriesInUse(list, posts, NOW).some((r) => r.category.id === id(3)), false);
}

part("The category page's words");
is("its own line when it has one", categoryPageText({ id: id(1), name: "Recipes", about: "Fast dinners." }, "Ana's Kitchen"), { title: "Recipes · Ana's Kitchen blog", description: "Fast dinners." });
is("plain facts when it has none", categoryPageText({ id: id(1), name: "Recipes", about: "" }, "Ana's Kitchen").description, "Posts about Recipes on the blog of Ana's Kitchen.");

done();
