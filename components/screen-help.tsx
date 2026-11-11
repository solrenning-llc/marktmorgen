"use client";

import { usePathname } from "next/navigation";
import { Icon } from "@/components/icons";
import { NewTab } from "@/components/new-tab";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { HELP_CENTER_SEARCH, inStudio, screenAnswers } from "@/lib/screen-help";

/** Each link: 44 px tall at least, its words centered in it, underlined as a link. */
const LINK =
  "inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4 hover:text-violet-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand";

/**
 * "Help for this screen" (766 [STN13], unit 3), under the studio's top bar
 * on every studio screen, always in the same place (WCAG 3.2.6): the help
 * center's answers for the screen the creator is on (lib/screen-help.ts),
 * its search, a person by email, and, for whoever may open it, the store
 * check (app/studio/checkup).
 *
 * A native <details>: it opens with a tap, a click or the keyboard, works
 * with no script, and stays closed until it is asked for, so it never
 * interrupts (2.2.4). What it shows opens in the page under its button,
 * never over the menu or the screen. No video, no sound, no request: the
 * answers open in a new tab, said to a screen reader, so nothing typed on
 * the screen is lost.
 */
export function ScreenHelp({ checkup }: { checkup: string | null }) {
  return <ScreenHelpPanel pathname={usePathname()} checkup={checkup} />;
}

/** The panel for a given path, drawn the same on the server and in the browser. */
export function ScreenHelpPanel({ pathname, checkup }: { pathname: string | null; checkup: string | null }) {
  if (!inStudio(pathname)) return null;
  const answers = screenAnswers(pathname);
  return (
    <details className="min-w-0 open:basis-full">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full bg-paper px-4 text-sm font-semibold text-ink ring-1 ring-line hover:ring-violet-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand [&::-webkit-details-marker]:hidden">
        <Icon name="info" size={16} />
        Help for this screen
      </summary>
      <div className="mt-2 max-w-[80ch] rounded-2xl bg-white p-4 text-sm leading-relaxed text-ink-soft ring-1 ring-line">
        <p>{answers.length ? "Answers for this screen, from our help center. Each one opens in a new tab, so you keep your place here." : "No answer here is just for this screen yet."}</p>
        {answers.length ? (
          <ul className="mt-1">
            {answers.map((answer) => (
              <li key={answer.id}>
                <a href={`/help#${answer.id}`} target="_blank" rel="noopener" className={LINK}>
                  {answer.q}<NewTab language="en" />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="mt-2 border-t border-line pt-2">
          <li>
            <a href={HELP_CENTER_SEARCH} target="_blank" rel="noopener" className={LINK}>
              Search the help center<NewTab language="en" />
            </a>
          </li>
          <li>
            <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
              {`Email us at ${SUPPORT_EMAIL}`}
            </a>
          </li>
          {checkup ? (
            <li>
              <a href={checkup} className={LINK}>
                Check what is not working on your store
              </a>
            </li>
          ) : null}
        </ul>
      </div>
    </details>
  );
}
