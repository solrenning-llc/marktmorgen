import type { Metadata } from "next";
import Link from "next/link";
import { parseLanguage } from "@/lib/store-language";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { AiOn } from "@/components/ai-assist";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { BlogEditor } from "@/components/blog-editor";
import { allPosts, postSegment, readPost } from "@/lib/store-blog";
import { NewTab } from "@/components/new-tab";

export const metadata: Metadata = {
  title: "Blog — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The store's blog in the studio (lib/store-blog.ts): every post, drafts
 * too, and the one being written. For whoever may change what the store
 * page says.
 */
export default async function StudioBlogPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "page");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const editing = typeof query.edit === "string" ? query.edit : "";
  const [posts, open, left] = await Promise.all([
    allPosts(store.statsId),
    editing && editing !== "new" ? readPost(store.statsId, editing) : Promise.resolve(null),
    aiAvailableFor(store) ? aiLeft(store).catch(() => 0) : Promise.resolve(0),
  ]);
  const back = studioPath(store, "", "blog");
  const products = store.catalog.head.filter((p) => !p.hidden).map((p) => ({ id: p.id, title: p.title }));
  const live = (id: string, title: string) => `/@${store.handle}/blog/${postSegment({ id, title })}`;
  const writing = editing === "new" || open !== null;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Blog</p>
          <h1 className="t-h2 mt-3">Posts on your store&apos;s address</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`What you know, at marktmorgen.com/@${store.handle}/blog, where search engines find it and a post can end on one of your products. Each has its own address, its own title and description for search, and the blog has a feed readers and newsletter tools can follow.`}
          </p>

          <div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <section aria-labelledby="posts-title" className="card min-w-0 p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 id="posts-title" className="text-lg font-semibold">
                  {`Posts (${posts.length})`}
                </h2>
                <Link href={`${back}${back.includes("?") ? "&" : "?"}edit=new`} className="btn btn-secondary btn-sm">
                  New post
                </Link>
              </div>
              {posts.length === 0 ? (
                <p className="mt-3 text-sm text-ink-soft">No posts yet. Your store page links to the blog once one is published.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {posts.map((post) => (
                    <li key={post.id} className="py-2.5">
                      <Link href={`${back}${back.includes("?") ? "&" : "?"}edit=${post.id}`} className={`block rounded-lg px-2 py-1.5 hover:bg-paper ${post.id === editing ? "bg-lilac" : ""}`} aria-current={post.id === editing ? "page" : undefined}>
                        <span className="block font-semibold text-ink">{post.title}</span>
                        <span className="block text-xs text-ink-soft">{post.draft ? "Draft" : `Published ${DATE.format(new Date(post.publishedAt * 1000))}`}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label={open ? `Editing ${open.title}` : "A new post"} className="card min-w-0 p-5 sm:p-7">
              {writing ? (
                <AiOn value={aiAvailableFor(store) ? { on: true, left } : { on: false, left: 0 }}>
                  <BlogEditor
                    key={open?.id ?? "new"}
                    post={open ? { id: open.id, title: open.title, body: open.body, product: open.product, draft: open.draft, href: open.draft ? null : live(open.id, open.title) } : { id: null, title: "", body: "", product: null, draft: true, href: null }}
                    products={products}
                    back={back}
                    look={store.look}
                    language={parseLanguage(store.language)}
                  />
                </AiOn>
              ) : (
                <div className="text-ink-soft">
                  <p className="text-lg font-semibold text-ink">Write a post</p>
                  <p className="mt-2">Pick a post on the left to change it, or start a new one. AI can draft one from a few words about the topic.</p>
                  <Link href={`${back}${back.includes("?") ? "&" : "?"}edit=new`} className="btn btn-primary mt-4">
                    New post
                  </Link>
                  {store.posts > 0 ? (
                    <a href={`/@${store.handle}/blog`} target="_blank" rel="noopener noreferrer" className="btn btn-ghost mt-4">
                      Open your blog
                    <NewTab /></a>
                  ) : null}
                </div>
              )}
            </section>
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
