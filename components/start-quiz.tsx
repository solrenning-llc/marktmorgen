"use client";

import Link from "next/link";
import { useState } from "react";
import { type QuizFacts, type QuizQuestion, quizQuestions, quizResult } from "@/lib/start-quiz";

/**
 * The three questions of /start-here (562 [QZ1]; lib/start-quiz.ts) and the answer, worked out here in the
 * browser: nothing is sent or kept. Native radio groups with a legend, so they are reached and changed by keyboard;
 * the answer appears below once all three are answered and is announced, without moving focus or the page.
 */
export function StartQuiz({ facts, level = 2, id = "start" }: { facts: QuizFacts; level?: 2 | 3; id?: string }) {
  // The answer's heading sits one below the section around it: h2 on /start-here, h3 inside a blog section.
  const Heading = level === 2 ? "h2" : "h3";
  const Legend = level === 2 ? "t-h3" : "font-semibold text-lg";
  const questions = quizQuestions(facts.guides);
  const [answers, setAnswers] = useState<Partial<Record<QuizQuestion["id"], string>>>({});
  const result = quizResult(facts, answers);
  const left = questions.filter((q) => !answers[q.id]).length;
  return (
    <div className="mt-8 max-w-3xl">
      <form onSubmit={(e) => e.preventDefault()} className="space-y-8">
        {questions.map((question, n) => (
          <fieldset key={question.id} className="hm-faq-card p-5 sm:p-6">
            <legend className={`${Legend} px-1`}>{`${n + 1}. ${question.ask}`}</legend>
            <div className="mt-3 space-y-1">
              {question.choices.map((choice) => (
                <label key={choice.id} className="flex min-h-[44px] cursor-pointer items-center gap-3 text-lg">
                  <input
                    type="radio"
                    name={`${id}-${question.id}`}
                    value={choice.id}
                    className="h-5 w-5 shrink-0"
                    checked={answers[question.id] === choice.id}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: choice.id }))}
                  />
                  <span>{choice.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </form>
      <section aria-labelledby={`${id}-result-title`} className="mt-12">
        <Heading id={`${id}-result-title`} className={level === 2 ? "t-h2" : "t-h3"}>Where to start</Heading>
        {/* Only a short sentence is announced: the answer itself is read where it is, not repeated at each change. */}
        <p role="status" aria-live="polite" className="mt-4 text-lg">
          {result
            ? `Your starting point is below: the template “${result.starter.label}”, on the ${result.plan.name} plan.`
            : `Answer the ${left === 1 ? "last question" : `${left} questions`} above and your starting point appears here.`}
        </p>
        {result ? (
          <div className="mt-6 space-y-6">
            <p className="text-lg">Read these first:</p>
            <ul className="space-y-2">
              {[...result.links, ...(result.moving ? [result.moving] : [])].map((link) => (
                <li key={link.href}>
                  <Link href={link.href} prefetch={false} className="inline-flex min-h-11 items-center text-lg underline">{link.text}</Link>
                </li>
              ))}
            </ul>
            <p className="text-lg">
              {`In your studio, under Funnels, in “${result.gallery}”, choose “${result.starter.label}”. ${result.starter.hint}`}
            </p>
            {result.starter.gathers ? (
              <p className="text-lg">
                {`It gathers the email addresses of people who sign up. Sending emails to all of them later is on the ${result.listPlan.name} plan (${result.listPlan.monthly}), or you can connect your own email platform on any plan. `}
                <Link href="/platform/email-platforms" prefetch={false} className="underline">How connecting an email platform works</Link>
              </p>
            ) : null}
            <p className="text-lg">
              {`Everything above is on the ${result.plan.name} plan: ${result.plan.monthly}, or ${result.plan.yearly}. `}
              <Link href="/pricing#plans" prefetch={false} className="underline">Compare the plans</Link>
            </p>
            {result.plan.onSale ? null : <p className="font-semibold">Paid plans and paid selling are not open yet. You can prepare your store now.</p>}
            <p>
              <Link href={result.start.href} prefetch={false} className="btn btn-primary inline-flex min-h-12 items-center">{result.start.text}</Link>
            </p>
            <p className="text-sm">This is where to start, not a promise of sales. Your answers stay in this browser: they are not sent or kept.</p>
          </div>
        ) : null}
        <noscript>
          <p className="mt-4 text-lg">This quiz needs JavaScript. Without it, <Link className="underline" href="/platform">see every feature</Link> or <Link className="underline" href="/pricing#plans">compare the plans</Link>.</p>
        </noscript>
      </section>
    </div>
  );
}
