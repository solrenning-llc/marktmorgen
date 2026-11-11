import type { Metadata } from "next";
import Link from "next/link";
import { readUnsubToken } from "@/lib/contacts";
import { STOP_TOKEN, readStopToken } from "@/lib/checkout-recovery";
import { COMMUNITY_UNSUB, readCommunityUnsub } from "@/lib/community-mail";
import { UPDATE_STOP, readUpdateStop } from "@/lib/product-updates";
import { updatesWords } from "@/lib/buyer-words/updates";
import { readConfig } from "@/lib/community";
import { type Store, storeForPage } from "@/lib/store";
import { REVIEW_STOP, readReviewStop } from "@/lib/review-requests";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { countingFor } from "@/lib/mail-clicks";
import { blockWords } from "@/lib/buyer-words/blocks";

type Query = { [key: string]: string | string[] | undefined };

const param = (query: Query, key: string) => {
  const value = query[key];
  return typeof value === "string" ? value.slice(0, 60) : "";
};

/**
 * The store behind a link, for the language the page speaks, or null when
 * the link is not one we know — then the page is in English. A list's link
 * counts only while the store still has that list.
 */
async function storeOf(query: Query): Promise<Store | null> {
  const reminder = param(query, "r");
  if (reminder) {
    const found = STOP_TOKEN.test(reminder) ? await readStopToken(reminder) : null;
    return found?.handle ? storeForPage(found.handle) : null;
  }
  const review = param(query, "v");
  if (review) {
    const found = REVIEW_STOP.test(review) ? await readReviewStop(review) : null;
    return found?.handle ? storeForPage(found.handle) : null;
  }
  const community = param(query, "c");
  if (community) {
    // A link that could not be read just now is spoken of in English, as one we do not know the store of.
    const found = COMMUNITY_UNSUB.test(community) ? await readCommunityUnsub(community).catch(() => null) : null;
    return found ? storeForPage(found.handle) : null;
  }
  const update = param(query, "u");
  if (update) {
    const found = UPDATE_STOP.test(update) ? await readUpdateStop(update) : null;
    return found?.handle ? storeForPage(found.handle) : null;
  }
  const token = param(query, "t") || param(query, "l");
  const found = token ? await readUnsubToken(token) : null;
  const store = found?.handle ? await storeForPage(found.handle) : null;
  return store && found && store.listId === found.listId ? store : null;
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<Query> }): Promise<Metadata> {
  const store = await storeOf(await searchParams);
  return {
    title: `${affiliatesWords(store?.language).unsubscribeButton} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/** The language a page about this store's emails speaks: the store's, or English. */
const wordsFor = (store: Store | null) => affiliatesWords(store?.language);
const localeOf = (store: Store | null) => LANGUAGES[parseLanguage(store?.language)].locale;

/** One button, and the answer. Nobody is asked why. Said in the store's language (lib/buyer-words/affiliates.ts). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const reminder = param(query, "r");
  if (reminder) return <StopReminders token={reminder} />;
  const review = param(query, "v");
  if (review) return <StopReviewRequests token={review} notSaved={param(query, "done") === "0"} />;
  const update = param(query, "u");
  if (update) return <StopUpdates token={update} />;
  const community = param(query, "c");
  if (community) return <StopAnnouncements token={community} notSaved={param(query, "done") === "0"} />;
  const links = param(query, "l");
  if (links) return <StopLinkCounting token={links} store={await storeOf(query)} />;
  const token = param(query, "t");
  const found = token ? await readUnsubToken(token) : null;
  const listStore = found ? await storeOf(query) : null;
  const name = listStore ? listStore.mail?.fromName || listStore.name : "";
  const a = wordsFor(listStore);
  const notSaved = param(query, "done") === "0";

  return (
    <main id="content" lang={localeOf(listStore)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {!found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownListBody}</p>
          </>
        ) : found.contact.unsub ? (
          <>
            <h1 className="t-h3">{a.listDoneTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.listDone(found.email, name)}</p>
            {/* Leaving the list keeps the address on it, marked, so it is never written to again; this deletes it and the rest (lib/erasure-request.ts). */}
            {listStore ? (
              <p className="mt-4 text-sm">
                <Link href={`/privacy/delete?store=${encodeURIComponent(listStore.handle)}`} prefetch={false} className="underline underline-offset-4">
                  {blockWords(listStore.language).deleteMyData}
                </Link>
              </p>
            ) : null}
          </>
        ) : (
          <>
            <h1 className="t-h3">{a.listAsk(name)}</h1>
            <p className="mt-3 text-ink-soft">{a.forEmail(found.email)}</p>
            {/* done=0 on a link still found and not left: the last press was not saved (its read or write was unknown), so the button is offered again. */}
            <p role="status" className={notSaved ? "mt-3 font-semibold" : "sr-only"}>{notSaved ? a.reviewsNotSaved : ""}</p>
            <form action={`/api/mail/unsubscribe?t=${token}`} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-primary btn-block">{a.unsubscribeButton}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfCreator}</p>
      </div>
    </main>
  );
}

/**
 * One button that stops the counting of which links somebody uses in a
 * store's sequences, which they allowed apart from joining (lib/mail-clicks.ts).
 * They stay on the list; what was counted is deleted.
 */
async function StopLinkCounting({ token, store }: { token: string; store: Store | null }) {
  const found = await countingFor(token);
  const name = store ? store.mail?.fromName || store.name : "";
  const a = wordsFor(store);
  return (
    <main id="content" lang={localeOf(store)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {!found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownListBody}</p>
          </>
        ) : !found.on ? (
          <>
            <h1 className="t-h3">{a.clicksDoneTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.clicksDone(found.email, name)}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{a.clicksAsk(name)}</h1>
            <p className="mt-3 text-ink-soft">{a.clicksFor(found.email)}</p>
            <form action={`/api/mail/unsubscribe?l=${token}`} method="post" className="mt-6">
              <button type="submit" className="btn btn-primary btn-block">{a.clicksButton}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfCreator}</p>
      </div>
    </main>
  );
}

/**
 * The same one button, for a community's emails: announcements and live event reminders.
 * `notSaved`: the route answered done=0, so the last press was not saved (its read or write was
 * unknown). Said only while the link is still found and not stopped, with the button offered again.
 * A link whose read was unknown (CX-123 rule 24) is never called unknown nor stopped: the page says
 * it could not open it just now, in English, as the store is not known, and offers no button.
 */
async function StopAnnouncements({ token, notSaved }: { token: string; notSaved: boolean }) {
  let unread = false;
  const found = COMMUNITY_UNSUB.test(token)
    ? await readCommunityUnsub(token).catch(() => {
        unread = true;
        return null;
      })
    : null;
  const store = found ? await storeForPage(found.handle) : null;
  const config = found && store?.community?.id === found.community ? await readConfig(found.community) : null;
  const who = store ? store.mail?.fromName || store.name : "";
  const where = config?.name ?? "";
  const a = wordsFor(store);
  return (
    <main id="content" lang={localeOf(store)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {unread ? (
          <>
            <h1 className="t-h3">{a.linkNotReadTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.linkNotReadBody}</p>
          </>
        ) : !found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownOtherBody}</p>
          </>
        ) : !found.member.mail ? (
          <>
            <h1 className="t-h3">{a.communityDoneTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.communityDone(found.member.e, who, where)}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{a.communityAsk(who)}</h1>
            <p className="mt-3 text-ink-soft">{a.communityFor(found.member.e, where)}</p>
            <p role="status" className={notSaved ? "mt-3 font-semibold" : "sr-only"}>{notSaved ? a.reviewsNotSaved : ""}</p>
            <form action={`/api/mail/unsubscribe?c=${token}`} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-primary btn-block">{a.stopEmails}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfCreator}</p>
      </div>
    </main>
  );
}

/** The same one button, for a store's abandoned-checkout reminders. */
async function StopReminders({ token }: { token: string }) {
  const found = STOP_TOKEN.test(token) ? await readStopToken(token) : null;
  const store = found?.handle ? await storeForPage(found.handle) : null;
  const who = found?.storeName || "";
  const a = wordsFor(store);
  return (
    <main id="content" lang={localeOf(store)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {!found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownOtherBody}</p>
          </>
        ) : found.stopped ? (
          <>
            <h1 className="t-h3">{a.remindersDoneTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.remindersDone(found.email, who)}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{a.remindersAsk(who)}</h1>
            <p className="mt-3 text-ink-soft">{a.forEmail(found.email)}</p>
            <form action={`/api/mail/unsubscribe?r=${token}`} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-primary btn-block">{a.stopReminders}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfStore}</p>
      </div>
    </main>
  );
}

/** The same one button, for a store's emails asking for a review. */
/**
 * `notSaved`: the route answered done=0, so the last press was not saved (its write was unknown). Said only while the
 * link is still found and not stopped, with the button offered again (Claude 5's LOW on #3010).
 */
async function StopReviewRequests({ token, notSaved }: { token: string; notSaved: boolean }) {
  const found = REVIEW_STOP.test(token) ? await readReviewStop(token) : null;
  const store = found?.handle ? await storeForPage(found.handle) : null;
  const who = found?.storeName || "";
  const a = wordsFor(store);
  return (
    <main id="content" lang={localeOf(store)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {!found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownOtherBody}</p>
          </>
        ) : found.stopped ? (
          <>
            <h1 className="t-h3">{a.reviewsDoneTitle}</h1>
            <p className="mt-3 text-ink-soft">{a.reviewsDone(found.email, who)}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{a.reviewsAsk(who)}</h1>
            <p className="mt-3 text-ink-soft">{a.reviewsFor(found.email)}</p>
            <p role="status" className={notSaved ? "mt-3 font-semibold" : "sr-only"}>{notSaved ? a.reviewsNotSaved : ""}</p>
            <form action={`/api/mail/unsubscribe?v=${token}`} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-primary btn-block">{a.stopReviews}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfStore}</p>
      </div>
    </main>
  );
}

/** The same one button, for a store's emails telling its buyers of an update. */
async function StopUpdates({ token }: { token: string }) {
  const found = UPDATE_STOP.test(token) ? await readUpdateStop(token) : null;
  const store = found?.handle ? await storeForPage(found.handle) : null;
  const who = found?.storeName || "";
  const a = wordsFor(store);
  const u = updatesWords(store?.language);
  return (
    <main id="content" lang={localeOf(store)} className="min-h-screen bg-paper px-4 py-20 text-ink">
      <div className="card mx-auto max-w-md p-7 sm:p-9">
        {!found ? (
          <>
            <h1 className="t-h3">{a.unknownLink}</h1>
            <p className="mt-3 text-ink-soft">{a.unknownOtherBody}</p>
          </>
        ) : found.stopped ? (
          <>
            <h1 className="t-h3">{u.doneTitle}</h1>
            <p className="mt-3 text-ink-soft">{u.done(found.email, who)}</p>
          </>
        ) : (
          <>
            <h1 className="t-h3">{u.ask(who)}</h1>
            <p className="mt-3 text-ink-soft">{u.forEmail(found.email)}</p>
            <form action={`/api/mail/unsubscribe?u=${token}`} method="post" className="mt-6">
              <input type="hidden" name="from" value="page" />
              <button type="submit" className="btn btn-primary btn-block">{u.button}</button>
            </form>
          </>
        )}
        <p className="mt-6 text-sm text-ink-mute">{a.onBehalfStore}</p>
      </div>
    </main>
  );
}
