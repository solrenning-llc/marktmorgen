"use client";

/**
 * 299 [H5-2]: the one product the creator suggests to a student who has
 * finished the course (lib/course-shelf.ts courseOffers, lib/course-shelf-rules.ts
 * nextFor). Text and picture only: no video, nothing that plays, no discount,
 * countdown, scarcity, count or quote. It never takes the focus or changes the
 * page by itself (WCAG 3.2.5). "Hide this suggestion" hides it, and a cookie
 * in this browser only, scoped to the course, keeps it hidden: nothing is
 * sent or kept on the server.
 */
import { useState } from "react";
import Link from "next/link";
import { coursesWords } from "@/lib/buyer-words/courses";

/** The cookie that keeps a course's suggestion hidden in this browser once dismissed. */
export const NEXT_DISMISS_COOKIE = (courseId: string) => `nl_next_off_${courseId.replace(/[^a-zA-Z0-9]/g, "")}`;

/** How long the dismissal is kept: as long as a finished course is remembered (lib/course-finish.ts, 400 days). */
const KEEP_SECONDS = 400 * 86_400;

export type NextProduct = { id: string; title: string; price: string; href: string; image: string | null };

export function CourseNextBox({ courseId, store, product, language }: { courseId: string; store: string; product: NextProduct; language: string }) {
  const [hidden, setHidden] = useState(false);
  const w = coursesWords(language);
  if (hidden) return null;

  function dismiss() {
    document.cookie = `${NEXT_DISMISS_COOKIE(courseId)}=1; Max-Age=${KEEP_SECONDS}; Path=/; SameSite=Lax; Secure`;
    setHidden(true);
  }

  return (
    <section className="st-card mt-6 p-6 sm:p-8" aria-labelledby="course-next-title">
      <h2 id="course-next-title" className="font-display text-xl font-semibold">{w.nextTitle(store)}</h2>
      <p className="st-muted mt-2">{w.nextLine}</p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- the store's own product picture, served as the file itself
          <img src={product.image} alt="" width={96} height={96} className="h-24 w-24 rounded-xl object-cover" />
        ) : null}
        <p className="min-w-0">
          <Link href={product.href} prefetch={false} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
            {product.title}
          </Link>
          <span className="st-muted block text-sm">{product.price}</span>
        </p>
      </div>
      <button type="button" onClick={dismiss} className="btn st-btn-ghost btn-sm mt-4">
        {w.nextDismiss}
      </button>
    </section>
  );
}
