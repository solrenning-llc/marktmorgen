import { EmailField } from "@/components/email-field";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { pageAddress } from "@/lib/essential-exit";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { MANAGE_LINK_SECONDS, type Membership, admitManage, canManage, membershipsFor } from "@/lib/membership-manage";
import { takePublicRequest } from "@/lib/traffic";
import { formatMoney } from "@/lib/money";
import { speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import { choicesFor, liveTiers } from "@/lib/tier-switch";
import { YEARLY_TARGET, priceWords } from "@/lib/yearly-switch";

/** The time the page is drawn at, in seconds: whether a pause has started yet. */
function secondsNow(): number {
  return Math.floor(Date.now() / 1000);
}

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).yourMembership} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Where a member manages or cancels a membership, on their own.
 *
 * Two visits to the same page. The first asks for the address they pay with.
 * The second comes from the link in the email and shows one button. Opening
 * the page never changes anything; only the button asks Stripe for the
 * member's own page, where cancelling is one click.
 */
export default async function ManagePage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const asked = typeof query.token === "string" ? query.token : "";
  // Opening this page changes nothing, but it is one of the store's buyer requests (MÉDIO 4 of the audit of
  // 9 November 2026). With the emailed link it is the way out, essential (lib/essential-exit.ts): the link is read
  // first, and the store's month counts it but never refuses it; past the way out's own figures it says so ("daily")
  // and keeps the form. Without one it is the form alone, counted in the window (past it if it must) and drawn all the
  // same, since asking for the link is how a member gets out; what a buyer has never rests (tests/traffic.test.ts).
  const admitted = asked ? await admitManage(store, asked, await pageAddress()) : null;
  if (!asked) await takePublicRequest(store, "buyer").catch(() => false);
  const refused = admitted && !admitted.ok && admitted.reason !== "expired" ? admitted.reason : null;
  const token = refused ? "" : asked;
  const status = refused ?? (typeof query.status === "string" ? query.status : "");
  const memberships: Membership[] | null = token ? await membershipsFor(store, token) : null;
  const live = memberships !== null;
  // The plans each membership can switch to (lib/tier-switch.ts).
  const tiers = memberships?.length ? await liveTiers(store).catch(() => []) : [];
  const available = canManage(store);
  const say = speech(store);
  const { w } = say;
  const m = membershipWords(store.language);
  const pauseNotice: Record<string, string> = { paused: "paused", resumed: "resumed", "cannot-pause": "cannot", "resume-declined": "declined" };
  const notice =
    token && !live
      ? m.manageNotices.expired
      : m.manageNotices[status] ??
        (pauseNotice[status] ? m.pauseNotices[pauseNotice[status]] : status === "offer-expired" ? m.switchProblems.yearlyExpired : null);
  const nowSeconds = secondsNow();
  const hours = Math.round(MANAGE_LINK_SECONDS / 3600);
  // Out loud, the way a member thinks about what they pay: "$29 a month".
  const every = (one: Membership) =>
    m.every(one.interval === "year" ? "year" : one.interval === "week" ? "week" : one.interval === "day" ? "day" : "month", one.intervalCount);
  const endDate = (at: number) => say.date(at * 1000);

  const form = (
    <form action="/api/store/manage" method="post" className="mt-7 space-y-3">
      <input type="hidden" name="handle" value={store.handle} />
      <div aria-hidden="true" className="hidden">
        <label>
          {w.leaveEmpty}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label htmlFor="manage-email" className="st-label">
        {m.payEmailLabel}
      </label>
      <EmailField id="manage-email" name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
      <button type="submit" className="btn st-btn btn-block">
        {m.emailMeLink}
      </button>
      <p className="st-muted text-sm">
        {m.linkNote(store.name, hours)}
      </p>
    </form>
  );

  return (
    <div
      lang={say.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <div className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={72} height={72} className="st-avatar" style={{ width: 72, height: 72 }} />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <p className="st-muted mt-4 text-sm font-semibold">{store.name}</p>
        </div>

        <div className="st-card mt-6 p-6 sm:p-9">
          {token && live ? (
            <>
              {notice ? (
                <div className="st-note mb-6">
                  <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                  <p className="mt-1 text-sm">{notice.body}</p>
                </div>
              ) : null}
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {memberships.length > 1 ? m.yourMemberships : m.yourMembership}
              </h1>

              {/* Each membership with its own way out. Cancel goes straight to
                  Stripe's own cancellation page for that one membership. */}
              {memberships.length ? (
                <ul className="mt-6 space-y-3">
                  {memberships.map((one) => (
                    <li key={one.id} className="st-row">
                      <div className="min-w-0">
                        <p className="font-bold" style={{ color: "var(--st-text)" }}>{one.title}</p>
                        <p className="st-muted text-sm">
                          {one.amount ? `${formatMoney(one.amount, one.currency, say.lang.locale)} ${every(one)}` : null}
                          {one.endsAt ? `${one.amount ? " · " : ""}${m.ends(endDate(one.endsAt))}` : null}
                        </p>
                      </div>
                      {one.pause ? (
                        <div className="basis-full" data-paused>
                          <p className="st-note text-sm font-semibold">
                            {nowSeconds >= one.pause.from ? m.pause.pausedUntil(endDate(one.pause.until)) : m.pause.startsPause(endDate(one.pause.from), endDate(one.pause.until))}
                          </p>
                          <form action="/api/store/manage/pause" method="post" className="mt-2">
                            <input type="hidden" name="handle" value={store.handle} />
                            <input type="hidden" name="token" value={token} />
                            <input type="hidden" name="subscription" value={one.id} />
                            <input type="hidden" name="action" value="resume" />
                            <button type="submit" className="btn btn-secondary btn-sm">
                              {m.pause.resume}
                            </button>
                          </form>
                          {nowSeconds >= one.pause.from ? <p className="st-muted mt-1 text-xs">{m.pause.resumeNote}</p> : null}
                        </div>
                      ) : null}
                      {one.endsAt === null && store.leaving.on ? (
                        // The store asks why first (lib/leave-rules.ts); the page it opens has the way out on it.
                        <Link prefetch={false} href={`/@${store.handle}/manage/leave?token=${token}&sub=${one.id}`} className="btn btn-secondary btn-sm">
                          {m.cancel}
                        </Link>
                      ) : one.endsAt === null ? (
                        <form action="/api/store/manage/cancel" method="post">
                          <input type="hidden" name="handle" value={store.handle} />
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="subscription" value={one.id} />
                          <button type="submit" className="btn btn-secondary btn-sm">
                            {m.cancel}
                          </button>
                        </form>
                      ) : null}
                      {one.canPause && one.endsAt === null && !one.pause ? (
                        <details className="mt-3 w-full basis-full" data-pause>
                          <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--st-text)" }}>
                            {m.pause.button}
                          </summary>
                          <form action="/api/store/manage/pause" method="post" className="mt-2 space-y-2">
                            <input type="hidden" name="handle" value={store.handle} />
                            <input type="hidden" name="token" value={token} />
                            <input type="hidden" name="subscription" value={one.id} />
                            <input type="hidden" name="action" value="pause" />
                            <label className="st-label block" htmlFor={`pause-${one.id}`}>
                              {m.pause.choose}
                            </label>
                            <select id={`pause-${one.id}`} name="months" className="st-field" defaultValue="1">
                              {Array.from({ length: store.pause }, (_, i) => i + 1).map((n) => (
                                <option key={n} value={n}>
                                  {m.pause.months(n)}
                                </option>
                              ))}
                            </select>
                            <p className="st-muted text-xs">{m.pause.note(one.periodEnd ? endDate(one.periodEnd) : "")}</p>
                            <button type="submit" className="btn st-btn btn-sm">
                              {m.pause.confirm}
                            </button>
                          </form>
                        </details>
                      ) : null}
                      {one.yearly && !one.pause ? (
                        // The same membership, paid yearly (lib/yearly-switch.ts): the next page says the exact amount first.
                        <div className="mt-3 w-full basis-full" data-pay-yearly>
                          <Link
                            prefetch={false}
                            href={`/@${store.handle}/manage/switch?token=${token}&sub=${one.id}&to=${YEARLY_TARGET}`}
                            className="btn btn-secondary btn-sm"
                          >
                            {m.payYearly(priceWords(store, one.yearly.cents, "year", store.language), formatMoney(one.yearly.saving, one.currency, say.lang.locale))}
                          </Link>
                          <p className="st-muted mt-1 text-xs">{m.exactFirst}</p>
                        </div>
                      ) : null}
                      {one.pause ? null : (() => {
                        const choices = choicesFor(store, one, tiers);
                        // On a tier, but paid in another currency than the store's now (22 [E5], unit 2b): say why there is no switch.
                        if (!choices.length) return one.currency.toLowerCase() !== store.currency && tiers.some((t) => t.id === one.product) ? <p className="st-muted mt-3 w-full basis-full text-sm">{m.switchCurrencyNote}</p> : null;
                        return (
                          <details className="mt-3 w-full basis-full">
                            <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--st-text)" }}>
                              {m.switchPlan}
                            </summary>
                            <ul className="mt-2 space-y-2">
                              {choices.map((c) => (
                                <li key={c.id}>
                                  <Link
                                    prefetch={false}
                                    href={`/@${store.handle}/manage/switch?token=${token}&sub=${one.id}&to=${c.id}`}
                                    className="st-row text-sm"
                                  >
                                    <span className="basis-full font-bold" style={{ color: "var(--st-text)" }}>{c.title}</span>
                                    <span className="st-muted -mt-2 basis-full">{`${c.words}${c.way === "up" ? m.upgrade : c.way === "down" ? m.downgrade : ""}`}</span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                            <p className="st-muted mt-2 text-xs">{m.exactFirst}</p>
                          </details>
                        );
                      })()}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="st-muted mt-4 text-lg leading-relaxed">
                  {m.cannotList}
                </p>
              )}

              <form action="/api/store/manage/open" method="post" className="mt-6">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {memberships.length ? m.changeCard : m.openMembership}
                </button>
              </form>
              <p className="st-muted mt-5 text-sm">
                {m.cancelNote}
              </p>
            </>
          ) : status === "sent" ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {m.checkInbox}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {m.sentBody(store.name)}
              </p>
              <p className="st-muted mt-4 text-sm">
                {m.tryOther}
              </p>
              {available ? form : null}
            </>
          ) : (
            <>
              {notice ? (
                <div className="st-note mb-6">
                  <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                  <p className="mt-1 text-sm">{notice.body}</p>
                </div>
              ) : null}
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {m.manageHead}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {available ? m.manageIntro(store.name) : m.manageUnavailable(store.name)}
              </p>
              {available ? form : null}
            </>
          )}
        </div>

        <div className="mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
