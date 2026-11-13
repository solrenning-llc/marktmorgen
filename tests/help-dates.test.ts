/**
 * The dates of the help answers (lib/help-dates.ts, 564 [HC1], complement of
 * 30 October 2026, 09h56; added 12 November 2026). Checked against the real
 * answers and the real pages:
 *
 *   - every answer has a day it was first written and a day its words last
 *     changed, real days, none in the future, never before the repository
 *     began (14 August 2026), and never updated before created;
 *   - the words of each answer are those that were dated: when an answer's
 *     text changes and its digest does not, this fails, so whoever changes it
 *     decides whether what it says changed (new "updated" day) or only a comma
 *     or a link (same day), and puts the new digest either way;
 *   - an answer's page says "Added" and "Last updated" (the same day when it never changed),
 *     each in a <time> element; /help lists the newest and the recently
 *     updated answers, at most 5 each, with their days.
 */
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HELP_DATES } from "@/lib/help-dates";
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { datedAnswers, helpDay, newestAnswers, recentlyUpdated } from "@/lib/help-pages";
import HelpAnswerPage from "@/app/help/[section]/[answer]/page";
import HelpPage from "@/app/help/page";
import { done, is, part } from "./check";

const answers = HELP_SECTIONS.flatMap((s) => s.items.map((item) => ({ section: s.id, id: answerId(item.q), item })));
const today = new Date().toISOString().slice(0, 10);
const real = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

async function main(): Promise<void> {
  part("Every answer is dated, with real days");
  is("every answer has its dates", answers.filter((a) => !HELP_DATES[a.id]).map((a) => a.id), []);
  is("no dates for an answer that is gone", Object.keys(HELP_DATES).filter((id) => !answers.some((a) => a.id === id)), []);
  is("real days, none in the future, none before the repository began, never updated before created", Object.entries(HELP_DATES).filter(([, d]) => !real(d.created) || !real(d.updated) || d.updated > today || d.created < "2026-08-14" || d.updated < d.created).map(([id]) => id), []);

  part("The words dated are the words shown");
  const changed = answers.filter((a) => HELP_DATES[a.id] && createHash("sha256").update([a.item.q, ...a.item.a].join("\n")).digest("hex").slice(0, 12) !== HELP_DATES[a.id].digest).map((a) => a.id);
  // If this fails: in lib/help-dates.ts, set that answer's "updated" to today if what it says changed (keep it for a comma or a link), and put the new digest.
  is("no answer's words changed without its dates being looked at", changed, []);

  part("On the pages");
  {
    const a = answers.find((x) => x.id === "can-i-sell-a-course")!;
    const d = HELP_DATES[a.id];
    const html = renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: a.section, answer: a.id }) }));
    is("Added, in a time element, with the day in US English", html.includes(`Added <time dateTime="${d.created}">${helpDay(d.created)}</time>`), true);
    is("Last updated, always, in a time element", html.includes(` · Last updated <time dateTime="${d.updated}">${helpDay(d.updated)}</time>`), true);
    const never = answers.find((x) => HELP_DATES[x.id] && HELP_DATES[x.id].updated === HELP_DATES[x.id].created);
    if (never) {
      const page = renderToStaticMarkup(await HelpAnswerPage({ params: Promise.resolve({ section: never.section, answer: never.id }) }));
      is("an answer never changed: Last updated is the day it was added", page.includes(` · Last updated <time dateTime="${HELP_DATES[never.id].created}">`), true);
    }
    const list = datedAnswers(HELP_DATES);
    const help = renderToStaticMarkup(createElement(HelpPage)).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    const newest = newestAnswers(list);
    const updated = recentlyUpdated(list);
    is("at most 5 of each", [newest.length <= 5, updated.length <= 5], [true, true]);
    is("the newest answers listed on /help, newest first, with their day", newest.every((r) => help.includes(r.q) && help.includes(`<time dateTime="${r.created}"`)) && newest.every((r, i) => i === 0 || newest[i - 1].created >= r.created), true);
    is("recently updated: only answers that changed after they were written, newest change first", updated.every((r, i) => r.updated > r.created && (i === 0 || updated[i - 1].updated >= r.updated)), true);
    is("a day in US English, the month in full", helpDay("2026-11-12"), "November 12, 2026");
    is("/help claims no single \"checked\" day for every answer: each answer carries its own dates", /Checked against the product/i.test(help), false);
  }
  done();
}

void main();
