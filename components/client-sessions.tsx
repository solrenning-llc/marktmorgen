import { speech } from "@/lib/buyer-words";
import { type SessionsWords, sessionsWords } from "@/lib/buyer-words/sessions";
import { icsLink } from "@/lib/calls";
import type { ClientNote, ClientTask } from "@/lib/client-shared";
import type { ClientSessions, SessionCall } from "@/lib/client-sessions";
import type { Store } from "@/lib/store";

/**
 * What "Your sessions" shows under its title (34 [F3], unit 2;
 * app/[handle]/orders/sessions/page.tsx): the client's sessions to come and
 * past, each a heading under its list's heading (WCAG 2.4.10), and under a
 * session what the creator shared for it. A link that cannot be used, a busy
 * store or a reading that failed is said in a status region, never as "no
 * sessions" (rule 24). No address is drawn: not the client's, not a
 * teammate's.
 */
export function ClientSessionsView({ view, store, token }: { view: ClientSessions; store: Store; token: string }) {
  const w = sessionsWords(store.language);
  const back = `/@${store.handle}/orders`;
  if (view.state !== "shown") {
    const notice = w.notices[view.state];
    const expired = view.state === "expired";
    return (
      <>
        <div className="st-note mt-5" role="status">
          <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
          <p className="mt-1 text-sm">{notice.body}</p>
        </div>
        {/* An expired link is never carried on: the purchases page asks for the address and emails a new one. */}
        <BackLink href={expired ? back : `${back}?${new URLSearchParams({ token })}`} label={expired ? w.getNewLink : w.backToList} />
      </>
    );
  }
  const none = view.upcoming.length + view.past.length === 0;
  return (
    <>
      <p className="st-muted mt-4 leading-relaxed">{w.intro(store.name)}</p>
      {none && !view.partial ? <p className="st-muted mt-6 text-lg leading-relaxed">{w.noneYet(store.name)}</p> : null}
      {view.upcoming.length ? (
        <SessionList id="up" title={w.upcoming(view.upcoming.length + view.upcomingMore)} calls={view.upcoming} more={view.upcomingMore} coming view={view} store={store} words={w} />
      ) : null}
      {view.past.length ? (
        <SessionList id="past" title={w.past(view.past.length + view.pastMore)} calls={view.past} more={view.pastMore} coming={false} view={view} store={store} words={w} />
      ) : null}
      {view.partial ? <p className="st-muted mt-6">{w.partial}</p> : null}
      <p className="st-muted mt-6 text-sm">{w.recentOnly}</p>
      {view.upcoming.length ? <p className="st-muted mt-2 text-sm">{w.joinOnOrders}</p> : null}
      <BackLink href={`${back}?${new URLSearchParams({ token })}`} label={w.backToList} />
    </>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <p className="mt-8">
      {/* Alone on its line, so at least 44 px high (WCAG 2.5.5). */}
      <a href={href} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
        {label}
      </a>
    </p>
  );
}

/** A time as the client reads it, in the zone they booked in and the store's language; a past one with its year. */
function when(ms: number, tz: string, locale: string, year: boolean): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, ...(year ? { year: "numeric" } : {}), weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/** The zone's short name at that instant, e.g. "EST" or "GMT+1", as the store's language writes it. */
function zoneName(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? tz;
}

function SessionList(props: { id: string; title: string; calls: SessionCall[]; more: number; coming: boolean; view: Extract<ClientSessions, { state: "shown" }>; store: Store; words: SessionsWords }) {
  const { id, title, calls, more, coming, view, store, words } = props;
  return (
    <section aria-labelledby={`${id}-title`} className="mt-6">
      <h2 id={`${id}-title`} className="font-display text-xl font-semibold">
        {title}
      </h2>
      <ul className="mt-4 space-y-4">
        {calls.map((call, i) => (
          <SessionCard
            key={call.session}
            call={call}
            id={`${id}${i}`}
            coming={coming}
            sameTitle={calls.some((other) => other !== call && other.title === call.title)}
            notes={view.notes.filter((note) => note.session === call.session)}
            tasks={view.tasks.filter((task) => task.session === call.session)}
            store={store}
            words={words}
          />
        ))}
      </ul>
      {more > 0 ? <p className="st-muted mt-4">{words.more(more)}</p> : null}
    </section>
  );
}

/**
 * One session. Its calendar link is named by the session it is for (WCAG
 * 2.4.9, technique ARIA7): the link's own words first (WCAG 2.5.3), then the
 * session's heading, then its time when the same title is booked twice.
 */
function SessionCard(props: { call: SessionCall; id: string; coming: boolean; sameTitle: boolean; notes: ClientNote[]; tasks: ClientTask[]; store: Store; words: SessionsWords }) {
  const { call, id, coming, sameTitle, notes, tasks, store, words } = props;
  const said = speech(store);
  const locale = said.lang.locale;
  const minutes = Math.round((call.end - call.start) / 60_000);
  const day = (d: string) => said.date(Date.parse(`${d}T12:00:00Z`));
  return (
    <li className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
      <h3 id={id} className="font-semibold [overflow-wrap:anywhere]">{call.title.trim() || words.untitled}</h3>
      <p id={sameTitle ? `${id}w` : undefined} className="mt-1 text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {when(call.start, call.tz, locale, !coming)}
      </p>
      <p className="st-muted text-sm">{words.length(zoneName(call.start, call.tz, locale), minutes)}</p>
      {coming ? (
        <p className="mt-3">
          <a href={icsLink("", store, call.session)} id={`${id}a`} aria-labelledby={`${id}a ${id}${sameTitle ? ` ${id}w` : ""}`} className="btn btn-secondary btn-block">
            {words.addToCalendar}
          </a>
        </p>
      ) : null}
      {notes.length ? (
        <div className="mt-4">
          <h4 className="text-sm font-semibold">{words.notesTitle(store.name)}</h4>
          <ul className="mt-2 space-y-2">
            {notes.map((note) => (
              <li key={note.id} className="text-sm [overflow-wrap:anywhere] whitespace-pre-line">
                {note.at > 0 ? <span className="st-muted block">{said.date(note.at * 1000)}</span> : null}
                {note.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {tasks.length ? (
        <div className="mt-4">
          <h4 className="text-sm font-semibold">{words.tasksTitle}</h4>
          <ul className="mt-2 space-y-2">
            {tasks.map((task) => (
              <li key={task.id} className="text-sm [overflow-wrap:anywhere]">
                {/* Done or not said in words, never by color or a mark alone (WCAG 1.4.1). */}
                <span className="font-semibold">{task.done ? words.taskDone : words.taskOpen}</span>
                {": "}
                {task.text}
                {task.due ? <span className="st-muted block">{words.due(day(task.due))}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
