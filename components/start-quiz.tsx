"use client";

import Link from "next/link";
import { useState } from "react";
import { type QuizFacts, type QuizQuestion, quizQuestions, quizResult } from "@/lib/start-quiz";

/**
 * The three questions of /start-here (562 [QZ1]; lib/start-quiz.ts) and the answer, worked out here in the
 * browser: nothing is sent or kept. Native radio groups with a legend, so they are reached and changed by keyboard;
 * the answer appears below once all three are answered and is announced, without moving focus or the page.
 */
export function StartQuiz({ facts }: { facts: QuizFacts }) {
  const questions = quizQuestions(facts.guides);
  const [answers, setAnswers] = useState<Partial<Record<QuizQuestion["id"], string>>>({});
  const result = quizResult(facts, answers);
  const left = questions.filter((q) => !answers[q.id]).length;
  return (
    <div className="mt-8 max-w-3xl">
      <form onSubmit={(e) => e.preventDefault()} className="space-y-8">
        {questions.map((question, n) => (
          <fieldset key={question.id} className="hm-faq-card p-5 sm:p-6">
            <legend className="t-h3 px-1">{`${n + 1}. ${question.ask}`}</legend>
            <div className="mt-3 space-y-1">
              {question.choices.map((choice) => (
                <label key={choice.id} className="flex min-h-[44px] cursor-pointer items-center gap-3 text-lg">
                  <input
                    type="radio"
                    name={`start-${question.id}`}
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
      <section aria-labelledby="start-result-title" className="mt-12">
        <h2 id="start-result-title" className="t-h2">Where to start</h2>
        <div role="status" aria-live="polite" className="mt-4">
          {result ? (
            <div className="space-y-6">
              <p className="text-lg">Read these first:</p>
              <ul className="space-y-2">
                {[...result.links, ...(result.moving ? [result.moving] : [])].map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} prefetch={false} className="inline-flex min-h-11 items-center text-lg underline">{link.text}</Link>
                  </li>
                ))}
              </ul>
              <p className="text-lg">
                {`In your studio, under Funnels, start from the template “${result.starter.label}”. ${result.starter.hint}`}
              </p>
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
          ) : (
            <p className="text-lg">{`Answer the ${left === 1 ? "last question" : `${left} questions`} above and your starting point appears here.`}</p>
          )}
        </div>
      </section>
    </div>
  );
}
