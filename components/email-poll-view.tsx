import type { PollPage } from "@/lib/email-poll-vote";
import { pollWords } from "@/lib/buyer-words/polls";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

/**
 * What the page a poll link opens draws (125 [F2-EMAIL-POLLS], unit 5;
 * app/poll/page.tsx reads the state with pollPage). Drawing it counts
 * nothing: both forms are POSTs to app/api/mail/poll/route.ts, which comes
 * back here with what happened (`done`).
 */
export function PollView({ page, broadcastId, link, asked, done }: { page: PollPage; broadcastId: string; link: string; asked: string; done: string }) {
  const language = page.state === "open" || page.state === "closed" || page.state === "resting" ? page.language : "en";
  const w = pollWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;

  if (page.state === "invalid" || page.state === "unknown" || page.state === "resting") {
    const [title, body] =
      page.state === "invalid" ? [w.unknownLinkTitle, w.unknownLink] : page.state === "resting" ? [w.title, w.resting] : [w.unreadTitle, w.unread];
    return (
      <main id="content" lang={locale} className="min-h-screen bg-paper px-4 py-20 text-ink">
        <div className="card mx-auto max-w-md p-7 sm:p-9">
          <h1 className="t-h3">{title}</h1>
          <p className="mt-3 text-ink-soft">{body}</p>
        </div>
      </main>
    );
  }

  const { poll, sender, closesAt } = page;
  const date = `${new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(closesAt)} (UTC)`;
  const said =
    done === "recorded" ? w.recorded
    : done === "withdrawn" ? w.withdrawn
    : done === "resting" ? w.resting
    : done === "unknown" ? w.notSaved
    : done === "invalid" ? w.unknownLink
    : "";
  const chosen = /^\d$/.test(asked) && Number(asked) < poll.options.length ? Number(asked) : null;
  const action = `/api/mail/poll?b=${encodeURIComponent(broadcastId)}&k=${encodeURIComponent(link)}`;

  return (
    <main id="content" lang={locale} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        <p className="text-sm text-ink-mute">{w.from(sender)}</p>
        <h1 className="t-h3 mt-1">{poll.question}</h1>
        <p role="status" className={said ? "mt-3 font-semibold" : "sr-only"}>{said}</p>
        {page.state === "closed" ? (
          <>
            <h2 className="mt-6 font-semibold">{w.closedTitle}</h2>
            <p className="mt-2 text-ink-soft">{w.closed}</p>
          </>
        ) : (
          <>
            <form action={action} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <fieldset>
                <legend className="font-semibold">{w.pick}</legend>
                <div className="mt-3 grid gap-2">
                  {poll.options.map((option, i) => (
                    <label key={i} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2">
                      <input type="radio" name="a" value={String(i)} defaultChecked={chosen === i} required className="h-5 w-5" />
                      <span>{option}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button type="submit" className="btn btn-primary btn-block mt-5">{w.confirm}</button>
            </form>
            <form action={action} method="post" className="mt-3">
              <input type="hidden" name="from" value="page" />
              <input type="hidden" name="a" value="none" />
              <button type="submit" className="btn btn-block">{w.takeBack}</button>
            </form>
            <p className="mt-5 text-sm text-ink-soft">{w.openedNothing}</p>
            <p className="mt-2 text-sm text-ink-soft">{w.until(date)}</p>
          </>
        )}
        <p className="mt-2 text-sm text-ink-soft">{w.totalsOnly}</p>
        <p className="mt-6 text-sm text-ink-mute">{affiliatesWords(language).onBehalfCreator}</p>
      </div>
    </main>
  );
}
