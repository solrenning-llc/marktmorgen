"use client";

import { useState } from "react";

/**
 * The course's "Next step" card (560 [AS1], unit 3), drawn on the course's
 * page for a student who may see it (lib/course-next-step.ts decides): the
 * product's title, its published price, the creator's line and a button to its
 * page. Nothing else: no discount, countdown, count of buyers or testimonial.
 * "No thanks" is a real button; it keeps the answer in this browser (a cookie
 * holding only "1", NEXT_STEP_NO_SECONDS) and says so, and the card is gone.
 */
export function CourseNextStepCard({
  cookie,
  seconds,
  href,
  title,
  price,
  line,
  words,
}: {
  cookie: string;
  seconds: number;
  href: string;
  title: string;
  price: string;
  line: string;
  words: { label: string; see: string; noThanks: string; done: string };
}) {
  const [declined, setDeclined] = useState(false);
  if (declined) {
    return (
      <p className="st-note mt-6 text-sm" role="status">
        {words.done}
      </p>
    );
  }
  return (
    <section className="st-card mt-6 p-6 sm:p-8" aria-labelledby="next-step-title" data-course-next-step="">
      <p className="st-label">{words.label}</p>
      <h2 id="next-step-title" className="font-display mt-1 text-xl font-semibold">
        {title}
      </h2>
      <p className="mt-1 text-sm font-semibold">{price}</p>
      {line ? <p className="st-muted mt-3 leading-relaxed">{line}</p> : null}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a href={href} className="btn st-btn">
          {words.see}
        </a>
        <button
          type="button"
          className="st-footer-link inline-flex min-h-11 items-center px-2 text-sm font-semibold underline underline-offset-4"
          aria-describedby="next-step-title"
          onClick={() => {
            const secure = location.protocol === "https:" ? "; Secure" : "";
            document.cookie = `${cookie}=1; Path=/; Max-Age=${seconds}; SameSite=Lax${secure}`;
            setDeclined(true);
          }}
        >
          {words.noThanks}
        </button>
      </div>
    </section>
  );
}
