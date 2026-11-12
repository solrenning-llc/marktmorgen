"use client";

import { useEffect, useRef } from "react";

/**
 * The quiz's check before sending (WCAG 2.2 3.3.4 and 3.3.6, components/lesson-quiz.tsx): a question left blank
 * holds the try in the page, so nothing is counted and nothing the student ticked is lost (3.3.7). It shows the
 * alert and the "not answered" line beside each blank question, and moves focus to the first one. Each line
 * hides again once its question is answered. Without scripts the server makes the same check
 * (app/api/store/course/quiz/route.ts) and the page comes back saying the same.
 */
export function QuizAnswerCheck({ alertId }: { alertId: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const groups = () => [...form.querySelectorAll<HTMLFieldSetElement>("fieldset[data-quiz-question]")];
    const answered = (group: HTMLFieldSetElement) => group.querySelector("input:checked") !== null;
    const note = (group: HTMLFieldSetElement) => {
      const id = group.getAttribute("aria-describedby");
      return id ? document.getElementById(id) : null;
    };
    const alert = () => document.getElementById(alertId);

    const onSubmit = (event: SubmitEvent) => {
      const blank = groups().filter((group) => !answered(group));
      for (const group of groups()) note(group)?.toggleAttribute("hidden", answered(group));
      const box = alert();
      if (!blank.length) {
        box?.setAttribute("hidden", "");
        return;
      }
      event.preventDefault();
      // Shown again, so a screen reader hears it even when it was already showing.
      if (box) {
        box.setAttribute("hidden", "");
        requestAnimationFrame(() => box.removeAttribute("hidden"));
      }
      blank[0].querySelector<HTMLInputElement>("input:not([type=hidden])")?.focus();
    };
    const onChange = (event: Event) => {
      const group = (event.target as Element | null)?.closest<HTMLFieldSetElement>("fieldset[data-quiz-question]");
      if (group && answered(group)) note(group)?.setAttribute("hidden", "");
      if (groups().every(answered)) alert()?.setAttribute("hidden", "");
    };
    form.addEventListener("submit", onSubmit);
    form.addEventListener("change", onChange);
    return () => {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("change", onChange);
    };
  }, [alertId]);

  return <span ref={ref} hidden data-quiz-check="" />;
}
