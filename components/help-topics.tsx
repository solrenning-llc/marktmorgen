"use client";

import Link from "next/link";
import { useId, useState, useSyncExternalStore } from "react";
import { type HelpTopic, filterTopics } from "@/lib/help-topics-rules";

// Until scripts run, the list stays open and the filter off: folding or filtering could not work yet.
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/**
 * The help center's topics beside a section or an answer (564 [HC1]): every
 * area of the studio by name, each to its answer's page, with "Filter by name"
 * narrowing only this list, in the browser. On a small screen the list starts
 * folded under "All help topics"; on a wide one it is always open. Without
 * scripts the whole list is simply there, open, with no filter.
 */
export function HelpTopics({ topics, current }: { topics: HelpTopic[]; current?: string }) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const field = useId();
  const listId = useId();
  const shown = filterTopics(topics, typed);
  const here = current ? topics.find((topic) => topic.href === current) : undefined;
  return (
    <nav aria-label="All help topics" className="min-w-0" data-help-topics>
      {ready ? (
        // In a box of its own: the site's .btn display would win over a lg:hidden on the button itself.
        <div className="lg:hidden">
          <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
            All help topics
          </button>
        </div>
      ) : null}
      <div id={listId} className={`${!ready || open ? "block" : "hidden"} mt-3 lg:mt-0 lg:block`}>
        {/* Drawn once scripts run: before that a filter could not filter, so none is offered, not even a disabled one. */}
        {ready ? (
          <>
            <label htmlFor={field} className="text-sm font-semibold text-ink">
              Filter by name
            </label>
            <input id={field} type="search" className="field mt-1 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            <p role="status" className="mt-2 text-sm text-ink-soft">
              {typed.trim() ? (shown.length ? `${shown.length} ${shown.length === 1 ? "topic" : "topics"}` : "No topic has that in its name.") : ""}
            </p>
          </>
        ) : null}
        <ul className="mt-2 space-y-0.5">
          {shown.map((topic) => (
            <li key={topic.href + topic.name}>
              {/* The whole row is the link, so even "Tax" is a 44 by 44 px target (2.5.5). Areas that share an answer
                  share its page: only the first of them is marked as the page you are on. */}
              <Link
                href={topic.href}
                aria-current={topic === here ? "page" : undefined}
                className={`flex min-h-11 w-full items-center text-[0.9375rem] underline-offset-4 hover:underline ${topic === here ? "font-semibold text-ink" : "text-ink-soft"}`}
              >
                {topic.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
