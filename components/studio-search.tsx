"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import {
  MAX_QUERY,
  type SearchAnswer,
  answerSentence,
  cleanQuery,
  enterTarget,
  hasAt,
  isAddress,
  searchScheduler,
} from "@/lib/studio-search-rules";

// Drawn only once the page's script runs: before that the box could not search, so it is not shown at all.
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

type Reply = { status: number; body: SearchAnswer & { ok?: boolean; error?: string; message?: string } };
type Option = { key: string; group: string; title: string; detail: string; href?: string; buyer?: string };

/** What the box says when the route answered with a refusal, in the route's own words where it gave them. */
function refusalSentence(reply: Reply): string {
  if (reply.body.message) return reply.body.message;
  if (reply.body.error === "signed_out") return "Your sign-in ended. Sign in again to search.";
  if (reply.body.error === "store_gone") return "This store can't be opened with your account now. Reload the page.";
  return "We could not search just now. Try again in a moment.";
}

/**
 * The studio's one search box (766 [STN13], unit 1), under the top bar of
 * every studio screen: the store's products, its own pages and the studio's
 * tools, found by name; for a role that may read orders, a buyer's whole email
 * address opens that buyer's page.
 *
 * The WAI-ARIA Authoring Practices combobox with a grouped listbox: focus
 * stays in the field, the arrows move through the results (Home and End to
 * the first and last once one is chosen), Enter opens the chosen one (or the
 * only one, when none is chosen: enterTarget), Escape
 * closes the list and then clears the field, and Tab leaves as it always
 * does. The list sits in the page under the field, never over the menus. How
 * many were found is said once per answer in a polite live region, drawn
 * anew each time so the same words are said again. The whole block is the
 * studio's search landmark.
 *
 * Searching waits SEARCH_DELAY_MS after the last key and keeps the last
 * answers, so typing never reads per key (lib/studio-search-rules.ts,
 * searchScheduler); each search is counted by the route before it reads.
 */
export function StudioSearch({ sid, buyers }: { sid: string; buyers: boolean }) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const base = useId();
  const inputId = `${base}-field`;
  const hintId = `${base}-hint`;
  const listId = `${base}-list`;
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  const [sentence, setSentence] = useState("");
  // Bumped with every sentence said, so the live region's words are drawn anew and read out even when unchanged.
  const [said, setSaid] = useState(0);
  const say = (words: string) => {
    setSentence(words);
    setSaid((n) => n + 1);
  };
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const scheduler = useRef<ReturnType<typeof searchScheduler<Reply>> | null>(null);

  const schedule = () => {
    scheduler.current ??= searchScheduler<Reply>({
      run: async (q, signal) => {
        const response = await fetch("/api/store/studio-search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
          body: JSON.stringify({ q }),
          signal,
        });
        const body = (await response.json().catch(() => ({}))) as Reply["body"];
        return { status: response.status, body };
      },
      ok: (reply) => reply.status === 200 && reply.body.ok === true && Array.isArray(reply.body.groups),
      answer: (q, reply) => {
        if (reply.status === 200 && reply.body.ok === true && Array.isArray(reply.body.groups)) {
          setAnswer({ groups: reply.body.groups });
          say(answerSentence({ groups: reply.body.groups }, q));
        } else {
          setAnswer(null);
          say(refusalSentence(reply));
        }
      },
      failed: () => {
        setAnswer(null);
        say("We could not search just now. Check your connection and try again.");
      },
    });
    return scheduler.current;
  };

  const query = cleanQuery(text);
  const address = buyers && query !== null && isAddress(query) ? query.trim() : "";
  const options: Option[] = address
    ? [{ key: "buyer", group: "Buyers", title: `Open the page of ${address}`, detail: "Their payments, courses and your team's notes.", buyer: address }]
    : (answer?.groups ?? []).flatMap((group) =>
        group.results.map((result) => ({ key: `${group.id}-${result.id}`, group: group.title, title: result.title, detail: result.detail, href: result.href })),
      );
  const expanded = open && options.length > 0;
  const optionId = (index: number) => `${listId}-${index}`;

  const change = (value: string) => {
    setText(value);
    setActive(-1);
    setOpen(true);
    const q = cleanQuery(value);
    if (q === null) {
      schedule().type(null);
      setAnswer(null);
      setSentence("");
      return;
    }
    if (hasAt(q)) {
      schedule().type(null);
      setAnswer(null);
      say(
        buyers
          ? isAddress(q)
            ? "1 result: open this buyer's page."
            : "To open a buyer's page, type their whole email address."
          : "Email addresses are not searched here. Search by the name of a product, a page or a tool.",
      );
      return;
    }
    schedule().type(q);
  };

  const choose = async (index: number) => {
    const option = options[index];
    if (!option || busy) return;
    if (option.href) {
      window.location.assign(option.href);
      return;
    }
    if (!option.buyer) return;
    setBusy(true);
    try {
      const response = await fetch("/api/store/person", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
        body: JSON.stringify({ action: "find", email: option.buyer }),
      });
      const reply = (await response.json().catch(() => ({}))) as { ok?: boolean; href?: string; error?: string; message?: string };
      if (reply.ok && reply.href) {
        window.location.assign(reply.href);
        return;
      }
      say(
        reply.message
          ? reply.message
          : reply.error === "limited"
            ? "That is a lot of buyer look-ups in one hour. Try again a little later."
            : "We could not open that buyer's page just now. Try again in a moment.",
      );
    } catch {
      say("We could not open that buyer's page just now. Check your connection and try again.");
    }
    setBusy(false);
  };

  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const last = options.length - 1;
    if (event.key === "ArrowDown" && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive(active < 0 || active >= last ? 0 : active + 1);
    } else if (event.key === "ArrowUp" && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive(active <= 0 ? last : active - 1);
    } else if ((event.key === "Home" || event.key === "End") && expanded && active >= 0) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter" && expanded && enterTarget(active, options.length) >= 0) {
      event.preventDefault();
      void choose(enterTarget(active, options.length));
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (expanded) {
        setOpen(false);
        setActive(-1);
      } else {
        change("");
      }
    }
  };

  if (!ready) return null;

  const groups: { title: string; items: { option: Option; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const current = groups.at(-1);
    if (current && current.title === option.group) current.items.push({ option, index });
    else groups.push({ title: option.group, items: [{ option, index }] });
  });

  return (
    <div role="search" aria-label="Studio" className="border-b border-line bg-white">
      <div className="container-page py-3">
        <label htmlFor={inputId} className="field-label">
          Search the studio
        </label>
        <p id={hintId} className="mt-1 text-sm text-ink-soft">
          {buyers
            ? "Find a product, one of your pages or a tool by its name. To open a buyer's page, type their whole email address."
            : "Find a product, one of your pages or a tool by its name."}
        </p>
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY}
          value={text}
          placeholder="For example: planner, About, Inbox"
          onChange={(event) => change(event.target.value)}
          onKeyDown={keys}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          className="field mt-2 min-h-[44px] w-full"
        />
        <p aria-live="polite" className="mt-2 text-sm text-ink-soft">
          <span key={said}>{sentence}</span>
        </p>
        <div role="listbox" id={listId} aria-label="Search results" hidden={!expanded} className="mt-2 rounded-2xl bg-white p-1 ring-1 ring-line">
          {groups.map((group, g) => (
            <div key={group.title} role="group" aria-labelledby={`${listId}-g${g}`}>
              <div id={`${listId}-g${g}`} role="presentation" className="px-3 pb-1 pt-2 text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">
                {group.title}
              </div>
              {group.items.map(({ option, index }) => (
                <div
                  key={option.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  // Keeps focus in the field, so the list is not closed before the choice is taken.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void choose(index)}
                  className={`flex min-h-[44px] cursor-pointer flex-col justify-center rounded-[12px] px-3 py-2 transition-colors motion-reduce:transition-none ${
                    index === active ? "bg-lilac text-violet-ink outline outline-2 outline-violet-brand" : "text-ink hover:bg-paper"
                  }`}
                >
                  <span className="font-semibold">{option.title}</span>
                  <span className="text-sm text-ink-soft">{option.detail}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
