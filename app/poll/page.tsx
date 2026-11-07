import type { ReactNode } from "react";
import type { Metadata } from "next";
import { type Store, storeForPage } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { type Ballot, POLL_PRESSES_AN_HOUR, answerOf, ballotUrl, pollClosed, readBallot, readPollRecord } from "@/lib/mail-poll-votes";
import { type PollWords, pollWords } from "@/lib/buyer-words/mail-poll";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

type Query = { [key: string]: string | string[] | undefined };

export const metadata: Metadata = {
  title: "Your answer — Marktmorgen",
  robots: { index: false, follow: false },
};

/** The ballot's own address on this site, without the site: what the form posts to and the other answers link to. */
const path = (ballot: Ballot, answer = ballot.answer) => ballotUrl({ ...ballot, answer }).replace(/^https:\/\/[^/]+/, "");

function Card({ store, title, children, words }: { store: Store | null; title: string; children?: ReactNode; words: PollWords }) {
  const name = store ? store.mail?.fromName || store.name : "";
  return (
    <main id="content" lang={LANGUAGES[parseLanguage(store?.language)].locale} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        <h1 className="t-h3">{title}</h1>
        {children}
        {name ? <p className="mt-6 text-sm text-ink-soft">{words.privacy(name)}</p> : null}
      </div>
    </main>
  );
}

/**
 * Where a poll's answer link in a store's email opens (lib/mail-poll.ts,
 * lib/mail-poll-votes.ts). Opening it records nothing: the button on it
 * does, so a mail scanner that opens every link answers nothing. It says
 * what is true now, read back: "recorded" only when this answer is kept as
 * the reader's, never because the address says so.
 */
export default async function PollPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const en = pollWords("en");
  if (query.preview === "1") {
    return (
      <Card store={null} title={en.previewTitle} words={en}>
        <p className="mt-3 text-ink-soft">{en.preview}</p>
      </Card>
    );
  }
  const ballot = readBallot(query);
  if (!ballot) {
    return (
      <Card store={null} title={en.unknownTitle} words={en}>
        <p className="mt-3 text-ink-soft">{en.unknown}</p>
      </Card>
    );
  }
  // The store from the signed link; its public request is taken before anything of the poll is read.
  const found = await storeForPage(ballot.handle).catch(() => null);
  const store = found && found.listId === ballot.listId ? found : null;
  const words = pollWords(store?.language);
  const failed = (
    <Card store={store} title={words.failedTitle} words={words}>
      <p className="mt-3 text-ink-soft">{words.failed}</p>
    </Card>
  );
  if (!store) {
    return (
      <Card store={null} title={words.closedTitle} words={words}>
        <p className="mt-3 text-ink-soft">{words.closed}</p>
      </Card>
    );
  }
  if (!(await takePublicRequest(store).catch(() => false))) return failed;
  const done = typeof query.done === "string" ? query.done : "";
  if (done === "limited") {
    return (
      <Card store={store} title={words.limitedTitle} words={words}>
        <p className="mt-3 text-ink-soft">{words.limited(POLL_PRESSES_AN_HOUR)}</p>
      </Card>
    );
  }
  const record = await readPollRecord(ballot.listId, ballot.pollId);
  if (record === "failed") return failed;
  if (!record || record.handle !== ballot.handle) {
    return (
      <Card store={store} title={words.closedTitle} words={words}>
        <p className="mt-3 text-ink-soft">{words.closed}</p>
      </Card>
    );
  }
  if (ballot.answer >= record.answers.length) {
    return (
      <Card store={store} title={words.unknownTitle} words={words}>
        <p className="mt-3 text-ink-soft">{words.unknown}</p>
      </Card>
    );
  }
  const mine = await answerOf(ballot);
  if (mine === "failed" || done === "failed") return failed;
  if (pollClosed(record)) {
    return (
      <Card store={store} title={words.closedTitle} words={words}>
        <p className="mt-3 text-ink-soft">{words.closed}</p>
      </Card>
    );
  }
  if (mine !== null) {
    const thanked = done === "recorded" && mine === ballot.answer;
    const answer = record.answers[mine] ?? "";
    return (
      <Card store={store} title={thanked ? words.thanksTitle : words.alreadyTitle} words={words}>
        <p className="mt-3 text-ink-soft">{record.question}</p>
        <p className="mt-2 font-semibold">{thanked ? words.thanks(answer) : words.already(answer)}</p>
        <form action={`/api/mail/poll${path(ballot).replace(/^\/poll/, "")}`} method="post" className="mt-6">
          <input type="hidden" name="do" value="withdraw" />
          <button type="submit" className="btn btn-secondary btn-block">{words.withdraw}</button>
        </form>
      </Card>
    );
  }
  const others = record.answers.map((text, answer) => ({ text, answer })).filter((one) => one.answer !== ballot.answer);
  return (
    <Card store={store} title={done === "withdrawn" ? words.withdrawnTitle : record.question} words={words}>
      {done === "withdrawn" ? (
        <>
          <p className="mt-3 text-ink-soft" role="status">{words.withdrawn}</p>
          <h2 className="mt-6 text-lg font-semibold">{record.question}</h2>
        </>
      ) : null}
      <p className="mt-3 font-semibold">{words.picked(record.answers[ballot.answer])}</p>
      <form action={`/api/mail/poll${path(ballot).replace(/^\/poll/, "")}`} method="post" className="mt-6">
        <input type="hidden" name="do" value="vote" />
        <button type="submit" className="btn btn-primary btn-block">{words.send}</button>
      </form>
      <p className="mt-3 text-sm text-ink-soft">{words.once}</p>
      {others.length ? (
        <>
          <h2 className="mt-6 text-sm font-semibold">{words.others}</h2>
          <ul className="mt-2 space-y-2">
            {others.map((one) => (
              <li key={one.answer}>
                <a href={path(ballot, one.answer)} className="inline-flex min-h-11 items-center underline underline-offset-4">
                  {one.text}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
