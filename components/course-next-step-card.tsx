"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The course's "Next step" card (560 [AS1], unit 3), drawn on the course's
 * page for a student who may see it (lib/course-next-step.ts decides): the
 * product's title, its published price, the creator's line and a button to its
 * page. Nothing else: no discount, countdown, count of buyers or testimonial.
 *
 * "No thanks" is a real button in a plain form: the server keeps the answer in
 * this browser (app/api/store/course/no-thanks, a cookie that holds only "1"
 * for a year), with no script needed. With script, the answer is sent without
 * leaving the page, the card goes, and focus moves to the sentence that says it
 * is done, in a status region that was there from the start, so it is read out
 * (review of #3530: focus kept, WCAG 2.4.3, 4.1.3). If the answer is not
 * confirmed, the form is sent the plain way.
 */
export function CourseNextStepCard({
  handle,
  courseId,
  productId,
  href,
  title,
  price,
  line,
  words,
}: {
  handle: string;
  courseId: string;
  productId: string;
  href: string;
  title: string;
  price: string;
  line: string;
  words: { label: string; see: string; noThanks: string; done: string };
}) {
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const said = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (declined) said.current?.focus();
  }, [declined]);
  return (
    <div className="mt-6" data-course-next-step-place="">
      <div role="status" aria-live="polite">
        {declined ? (
          <p ref={said} tabIndex={-1} className="st-note text-sm">
            {words.done}
          </p>
        ) : null}
      </div>
      {declined ? null : (
        <section className="st-card p-6 sm:p-8" aria-labelledby="next-step-title" data-course-next-step="">
          <p className="st-label">{words.label}</p>
          <h2 id="next-step-title" className="font-display mt-1 text-xl font-semibold">
            {title}
          </h2>
          <p className="mt-1 text-sm font-semibold">{price}</p>
          {line ? <p className="st-muted mt-3 leading-relaxed">{line}</p> : null}
          <form
            action="/api/store/course/no-thanks"
            method="post"
            className="mt-5 flex flex-wrap items-center gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              setBusy(true);
              const ok = await fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } })
                .then((response) => response.status === 204)
                .catch(() => false);
              setBusy(false);
              if (ok) setDeclined(true);
              else form.submit();
            }}
          >
            <input type="hidden" name="handle" value={handle} />
            <input type="hidden" name="course" value={courseId} />
            <input type="hidden" name="product" value={productId} />
            <a href={href} className="btn st-btn">
              {words.see}
            </a>
            <button
              type="submit"
              disabled={busy}
              aria-busy={busy}
              aria-describedby="next-step-title"
              className="st-footer-link inline-flex min-h-11 items-center px-2 text-sm font-semibold underline underline-offset-4"
            >
              {words.noThanks}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
