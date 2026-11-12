"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PostCover } from "@/components/post-cover";
import type { BlogPost } from "@/lib/blog";
import { formatPostDate } from "@/lib/blog";

/**
 * The search box and the category picker for the blog index. Everything is
 * filtered in the browser over a list that is already on the page, so nothing
 * is fetched and the results appear as the reader types.
 */
export function BlogBrowser({
  posts,
  categories,
}: {
  posts: BlogPost[];
  categories: string[];
}) {
  const [category, setCategory] = useState("All articles");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return posts.filter((post) => {
      if (category !== "All articles" && post.category !== category) {
        return false;
      }
      if (!needle) return true;
      return (
        post.title.toLowerCase().includes(needle) ||
        post.excerpt.toLowerCase().includes(needle) ||
        post.category.toLowerCase().includes(needle)
      );
    });
  }, [posts, category, query]);

  const options = ["All articles", ...categories];

  return (
    <div>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="-mx-1 flex flex-wrap gap-1.5 px-1 pb-1 lg:min-w-0 lg:flex-1" role="group" aria-label="Filter articles by category">
          {options.map((option) => {
            const active = option === category;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setCategory(option)}
                aria-pressed={active}
                className={`h-11 shrink-0 rounded-[10px] px-3.5 text-[0.9375rem] font-medium transition-colors ${
                  active ? "bg-ink text-white" : "bg-white text-ink-soft ring-1 ring-line hover:text-ink hover:ring-line-strong"
                }`}
              >
                {option}
              </button>
            );
          })}
        </div>

        <label className="relative block w-full shrink-0 lg:w-72">
          <span className="sr-only">Search the articles</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the articles"
            // The bang is load-bearing: .field sets its own padding and is
            // unlayered, so a plain pl-10 loses and the magnifier ends up
            // sitting on top of the placeholder.
            className="field pl-10!"
          />
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </label>
      </div>

      <p className="mt-6 text-sm text-ink-mute" aria-live="polite">
        {shown.length === posts.length ? `${posts.length} articles` : `${shown.length} of ${posts.length} articles`}
      </p>

      {/*
        The first article in an unfiltered list is given more room than the
        rest. A grid where every card weighs the same asks the reader to
        compare nine things at once; one card carrying more weight tells them
        where to start, and the moment they search or pick a category that
        ranking is no longer ours to make, so it goes away.
      */}
      {shown.length === 0 ? (
        <div className="mt-8 rounded-[var(--r-lg)] border border-dashed border-line-strong bg-white p-10 text-center">
          <p className="font-semibold text-ink">Nothing matches that yet.</p>
          <p className="mt-1 text-ink-soft">Try another word, or read everything.</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("All articles");
            }}
            className="btn btn-secondary btn-sm mt-5"
          >
            Show every article
          </button>
        </div>
      ) : (
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((post, i) => (
            <BlogCard key={post.slug} post={post} lead={i === 0 && !query.trim() && category === "All articles"} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BlogCard({ post, lead = false }: { post: BlogPost; lead?: boolean }) {
  return (
    <article
      className={`card card-hover group relative flex h-full flex-col overflow-hidden ${
        lead ? "sm:col-span-2 lg:col-span-2" : ""
      }`}
    >
      <PostCover post={post} size={lead ? "lg" : "sm"} />
      <div className={`flex flex-1 flex-col p-6 ${lead ? "sm:p-7" : ""}`}>
      <p className="flex items-center justify-between gap-3 text-[0.8125rem]">
        <span className="tag tag-brand">{post.category}</span>
        <span className="text-ink-mute">{post.readMinutes} min read</span>
      </p>
      {/* The ladder, not two fixed sizes: the lead post takes the section step
          and the rest take the one below it, and both scale with the screen. */}
      <h3 className={`mt-4 text-ink ${lead ? "t-section" : "t-h3"}`}>
        <Link href={`/blog/${post.slug}`} className="after:absolute after:inset-0 after:rounded-[var(--r-lg)]">
          {post.title}
        </Link>
      </h3>
      <p className={`mt-3 max-w-[46ch] flex-1 leading-relaxed text-ink-soft ${lead ? "text-base" : "text-[0.9375rem]"}`}>
        {post.excerpt}
      </p>
      <p className="mt-6 flex items-center justify-between border-t border-line pt-4 text-sm">
        <span className="text-ink-mute">{formatPostDate(post.date)}</span>
        <span className="flex items-center gap-1 font-semibold text-violet-deep">
          Read
          <span aria-hidden="true" className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">
            →
          </span>
        </span>
      </p>
      </div>
    </article>
  );
}
