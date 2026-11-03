import { EmailField } from "@/components/email-field";
import { SITE_URL } from "@/lib/site-url";
import type { Metadata } from "next";
import { readListings, recordListings } from "@/lib/catalog";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { formatMoney } from "@/lib/money";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { commissionRate, nextPayday } from "@/lib/affiliate-setting";
import { codeOwners } from "@/lib/affiliate-codes";
import { listCodes } from "@/lib/discount";
import { speech } from "@/lib/buyer-words";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { CHANGE_WAITS_SECONDS, shareRunning } from "@/lib/partner-terms-rules";
import {
  MAX_NOTE_LENGTH,
  affiliateCookieName,
  affiliateForSession,
  affiliateLink,
  affiliatesOn,
  buyersJoin,
  canApply,
  linkEmail,
  partnerChangeFor,
  readBook,
  recruitLink,
} from "@/lib/affiliates";
import { AFFILIATE_CODE_PATTERN } from "@/lib/affiliate-setting";
import { AffiliateLinkBox } from "@/components/affiliate-link-box";
import { AffiliateKit } from "@/components/affiliate-kit";
import { AffiliateCampaignLinks } from "@/components/affiliate-campaign-links";
import { AffiliatePromotionResults } from "@/components/affiliate-promotion-results";
import { kitProduct, productAffiliateLink } from "@/lib/affiliate-kit";
import { aiAvailableFor } from "@/lib/ai";
import { leadWords } from "@/lib/buyer-words/affiliate-leads";
import { type LeadStatus, maskEmail } from "@/lib/affiliate-lead-rules";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${affiliatesWords(store?.language).pageTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * A store's affiliate programme, seen from outside: its terms and the form to
 * apply, and — for an affiliate signed in on this browser — their link, their
 * clicks, the sales that came through it and what they earned and were paid.
 * Payouts are made by the creator, and every view of it says so. Every word
 * is in the store's language (lib/buyer-words/affiliates.ts).
 */
export default async function AffiliatesPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const { w, lang, date } = speech(store);
  const a = affiliatesWords(store.language);
  // Pay per lead (lib/affiliate-leads.ts): its terms, its disclosure and each lead's status.
  const lw = leadWords(store.language);
  /** In the currency it was paid in; totals are in the store's (lib/affiliates.ts, readBook). */
  const money = (cents: number, currency: string) => `${cents < 0 ? "-" : ""}${formatMoney(Math.abs(cents), currency, lang.locale)}`;
  const day = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString(lang.locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const num = (n: number) => n.toLocaleString(lang.locale);
  // A bonus line's own words, from its reference "bonus:<affiliate>:<YYYY-MM>:<sales>" (lib/affiliates.ts bonusLines).
  const bonusTitle = (ref: string) => {
    const [, , month = "", sales = "0"] = ref.split(":");
    const name = /^\d{4}-\d{2}$/.test(month)
      ? new Date(`${month}-01T00:00:00Z`).toLocaleDateString(lang.locale, { month: "long", year: "numeric", timeZone: "UTC" })
      : month;
    return a.bonusTitle(Number(sales) || 0, name);
  };
  const promise = (terms: typeof store.affiliates) => a.payoutPromise(store.name, terms.payday, terms.hold);
  const attribution = (terms: typeof store.affiliates) => a.attribution(terms.days, terms.rule === "first", terms.lifetime);

  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const status = typeof query.status === "string" ? query.status : "";
  // An affiliate's invitation link (lib/affiliates.ts recruitLink): checked when the application is sent.
  const by = typeof query.by === "string" && AFFILIATE_CODE_PATTERN.test(query.by) && store.affiliates.secondTier > 0 ? query.by : "";
  const order = typeof query.order === "string" && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(query.order) ? query.order : "";
  const linkFor = token ? await linkEmail(store, token) : null;
  const affiliate = await affiliateForSession(store, (await cookies()).get(affiliateCookieName(store.handle))?.value);
  const on = affiliatesOn(store);
  const open = canApply(store);
  const terms = store.affiliates;
  const book = affiliate ? await readBook(store, affiliate.id) : null;
  const row = book?.rows[0] ?? null;
  // The products a partner shares in, by name, so their own page can say what
  // they hold rather than leaving them to trust the email they accepted.
  const myShared = affiliate?.share
    ? (await readListings(store, affiliate.share.products)).filter((p) => p.priceCents > 0).map((p) => p.title)
    : [];
  // A change to that share the store asked for, waiting for this partner's
  // answer (630 [HN6](39), lib/partner-terms-rules.ts); one left unanswered
  // lapses on its own, so only one still open is shown.
  const { nowSeconds, change: askedChange, titles: askedTitles } = await partnerChangeFor(store, affiliate);
  /** The last day a share earns on, in the store's language: the day before its end. */
  const lastDay = (until: number) => day(until - 24 * 60 * 60);
  // Codes of the store's own that this affiliate was given, which earn with no
  // click at all (lib/affiliate-codes.ts). Only asked for once they are in.
  const myCodes =
    affiliate?.status === "approved" && on && store.hasDiscounts && store.stripeAccountId
      ? await (async () => {
          const owners = await codeOwners(store).catch(() => new Map<string, string>());
          const mine = [...owners].filter(([, id]) => id === affiliate.id).map(([promo]) => promo);
          if (!mine.length) return [];
          const listed = await listCodes(store.stripeAccountId as string).catch(() => ({ state: "error" as const }));
          if (listed.state !== "ok") return [];
          return listed.codes
            .filter((code) => code.active && code.off !== null && mine.includes(code.id))
            .map((code) => {
              const off = code.off as NonNullable<typeof code.off>;
              const label = off.kind === "percent" ? a.percentOff(off.percent) : a.amountOff(formatMoney(off.cents, off.currency, lang.locale));
              return { id: code.id, code: code.code, label };
            });
        })()
      : [];
  // The next day the creator said they pay, or null when they promised none.
  const due = nextPayday(terms.payday);
  const notice = token && !linkFor ? a.notices.expired : a.notices[status] ?? null;
  // Products that earn differently from the store-wide share, by name.
  // Only products with a rate of their own can differ, so only those are read.
  // The products an approved affiliate may have posts drafted about (lib/affiliate-kit.ts).
  const kitProducts =
    affiliate && affiliate.status === "approved" && on
      ? recordListings(store)
          .filter((listing) => kitProduct(store, affiliate, listing))
          .slice(0, 60)
          .map((listing) => ({ id: listing.id, title: listing.title }))
      : [];
  const promotionProducts = affiliate ? kitProducts.map(product => ({ ...product, url: productAffiliateLink(store, product, affiliate.code) })) : [];
  const different = (await readListings(store, Object.keys(terms.rates)))
    .filter((p) => !p.hidden && p.priceCents > 0 && (p.recurring === null || terms.recurring > 0) && commissionRate(terms, p.id) !== terms.percent)
    .map((p) => ({ title: p.title, rate: commissionRate(terms, p.id) }));

  const form = (
    <form action="/api/store/affiliates/apply" method="post" className="mt-7 space-y-3">
      <input type="hidden" name="handle" value={store.handle} />
      {by ? <input type="hidden" name="by" value={by} /> : null}
      <div aria-hidden="true" className="hidden">
        <label>
          {w.leaveEmpty}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label htmlFor="aff-email" className="st-label">
        {w.yourEmail}
      </label>
      <EmailField id="aff-email" name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
      <label htmlFor="aff-note" className="st-label pt-2">
        {a.whereShare} <span className="st-muted font-normal">{a.optional}</span>
      </label>
      <input
        id="aff-note"
        type="text"
        name="note"
        maxLength={MAX_NOTE_LENGTH}
        placeholder={a.notePlaceholder}
        className="st-field"
      />
      <button type="submit" className="btn st-btn btn-block">
        {a.emailMeLink}
      </button>
      <p className="st-muted text-sm">{a.formNote}</p>
    </form>
  );

  return (
    <div
      lang={lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-2xl px-4 py-14 sm:py-20">
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
          {token && linkFor ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {a.continueAs(linkFor)}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {a.continueBody(store.name)}
              </p>
              <form action="/api/store/affiliates/open" method="post" className="mt-7">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {a.openMyPage}
                </button>
              </form>
            </>
          ) : affiliate ? (
            <>
              {status === "applied" || status === "welcome" || status === "joined" ? (
                <div className="st-note mb-6" role="status">
                  <p className="font-bold" style={{ color: "var(--st-text)" }}>
                    {status === "applied" ? a.appliedTitle : status === "joined" ? a.joinedTitle : a.welcomeTitle}
                  </p>
                  <p className="mt-1 text-sm">
                    {status === "applied" ? a.appliedBody(store.name) : status === "joined" ? a.joinedBody : a.welcomeBody}
                  </p>
                </div>
              ) : null}
              <p className="st-price text-sm">
                {affiliate.status === "approved"
                  ? on
                    ? a.badgeAffiliate
                    : a.badgePaused
                  : affiliate.status === "pending"
                    ? a.badgePending
                    : affiliate.status === "declined"
                      ? a.badgeDeclined
                      : a.badgeRemoved}
              </p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {a.yourPageFor(store.name)}
              </h1>
              <p className="st-muted mt-2 text-sm [overflow-wrap:anywhere]">{affiliate.email}</p>

              {affiliate.status === "approved" && on ? (
                <>
                  <p className="st-label mt-7">{a.yourLink}</p>
                  <AffiliateLinkBox link={affiliateLink(store, affiliate.code)} words={{ label: a.yourLink, copy: a.copy, copied: a.copied }} />
                  <p className="st-muted mt-2 text-sm">
                    {a.orAddVia(affiliate.code)}
                  </p>
                  <p className="st-muted mt-2 text-sm">{attribution(store.affiliates)}</p>
                  <p className="st-muted mt-2 text-sm" data-disclose>{a.termDisclose}</p>
                  {store.affiliates.lead.kind !== "none" ? (
                    <>
                      <p className="st-muted mt-2 text-sm">{lw.term(store.affiliates.lead.kind, money(store.affiliates.lead.cents, store.currency), store.name)}</p>
                      <p className="st-muted mt-2 text-sm">{lw.termRules(store.affiliates.lead.hold, store.affiliates.lead.daily, money(store.affiliates.lead.budget, store.currency), store.name)}</p>
                      <p className="st-muted mt-2 text-sm" data-disclose-leads>{lw.disclose}</p>
                    </>
                  ) : null}
                  {/* The second tier (lib/affiliates.ts tierLines), only while the programme has one. */}
                  {store.affiliates.secondTier > 0 ? (
                    <>
                      <p className="st-label mt-7">{a.recruitLabel}</p>
                      <AffiliateLinkBox link={recruitLink(store, affiliate.code)} words={{ label: a.recruitLabel, copy: a.copy, copied: a.copied }} />
                      <p className="st-muted mt-2 text-sm">{a.recruitNote(store.affiliates.secondTier, store.name)}</p>
                    </>
                  ) : null}
                  <AffiliateCampaignLinks products={promotionProducts} />
                  <AffiliateKit handle={store.handle} language={store.language} products={aiAvailableFor(store) ? kitProducts : []} />
                  {/*
                    A code of the store's own, given to this affiliate
                    (lib/affiliate-codes.ts). It is the only thing on this page
                    that earns without a click, so it is worth more to an
                    affiliate who talks than the link above it.
                  */}
                  {myCodes.length ? (
                    <>
                      <p className="st-label mt-7">{a.codesLabel(myCodes.length)}</p>
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {myCodes.map((code) => (
                          <li
                            key={code.id}
                            className="rounded-2xl px-4 py-2 font-mono text-sm font-bold"
                            style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                          >
                            {code.code}
                            <span className="st-muted ml-2 font-sans text-xs font-normal">{code.label}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="st-muted mt-2 text-sm">
                        {myCodes.length === 1 ? a.codeNoteOne : a.codeNoteMany}
                      </p>
                    </>
                  ) : null}
                  {/*
                    A standing share of the product itself, which earns on
                    every sale and not only the ones they send
                    (lib/partner-share.ts). Said plainly, because it is the
                    part somebody agreed to in an email and should be able to
                    check without asking.
                  */}
                  {affiliate.share ? (
                    <div id="partner" className="scroll-mt-24">
                      <p className="st-label mt-7">{a.partnerShareLabel}</p>
                      {shareRunning(affiliate.share, nowSeconds) ? (
                        <p className="st-muted mt-2 text-sm">
                          {a.partnerShare(affiliate.share.percent, myShared.length ? myShared.join(", ") : a.sharedFallback)}{" "}
                          {a.partnerRuns(affiliate.share.until === undefined ? null : lastDay(affiliate.share.until))}
                        </p>
                      ) : (
                        <p className="st-muted mt-2 text-sm">{a.partnerEnded(lastDay(affiliate.share.until ?? nowSeconds))}</p>
                      )}
                      {askedChange ? (
                        <form action="/api/store/affiliates/partner-answer" method="post" className="mt-3 space-y-2 text-sm">
                          <input type="hidden" name="handle" value={store.handle} />
                          <p className="font-semibold">
                            {a.partnerAsked(
                              store.name,
                              askedChange.share ? askedChange.share.percent : null,
                              askedTitles.length ? askedTitles.join(", ") : a.sharedFallback,
                              askedChange.share?.until === undefined ? null : lastDay(askedChange.share.until),
                            )}
                          </p>
                          <p className="st-muted">{a.partnerAskedKeep(day(askedChange.asked + CHANGE_WAITS_SECONDS - 24 * 60 * 60))}</p>
                          <div className="flex flex-wrap gap-2">
                            <button type="submit" name="answer" value="yes" className="btn btn-primary btn-sm">
                              {a.partnerAccept}
                            </button>
                            <button type="submit" name="answer" value="no" className="btn btn-secondary btn-sm">
                              {a.partnerDecline}
                            </button>
                          </div>
                        </form>
                      ) : null}
                      {status === "partner-yes" || status === "partner-no" || status === "partner-cap" || status === "partner-none" ? (
                        <p className={`st-note mt-3 text-sm${status === "partner-yes" || status === "partner-no" ? "" : " font-semibold"}`} role="status">
                          {a.partnerAnswered[status === "partner-yes" ? "yes" : status === "partner-no" ? "no" : status === "partner-cap" ? "cap" : "none"]}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {affiliate.rate !== null ? (
                    <p className="st-muted mt-2 text-sm">
                      {a.yourRate(store.name, affiliate.rate)}
                    </p>
                  ) : null}
                </>
              ) : affiliate.status === "pending" ? (
                <p className="st-muted mt-5 leading-relaxed">
                  {a.pendingBody(store.name)}
                </p>
              ) : affiliate.status === "approved" ? (
                <p className="st-muted mt-5 leading-relaxed">
                  {a.pausedBody(store.name)}
                </p>
              ) : (
                <p className="st-muted mt-5 leading-relaxed">
                  {affiliate.status === "declined" ? a.declinedBody(store.name) : a.removedBody(store.name)}
                </p>
              )}

              {row && book ? (
                <>
                  <dl className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: a.clicks, value: num(row.clicks) },
                      { label: a.sales, value: num(row.sales) },
                      { label: a.earned, value: money(row.earned, book.currency) },
                      { label: row.owed < 0 ? a.paidAhead : a.owedToYou, value: money(Math.abs(row.owed), book.currency) },
                    ].map((tile) => (
                      <div key={tile.label} className="rounded-2xl px-4 py-3" style={{ background: "var(--st-accent-soft)" }}>
                        <dt className="st-muted text-xs font-semibold">{tile.label}</dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums" style={{ color: "var(--st-text)" }}>
                          {tile.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="st-muted mt-3 text-sm">
                    {a.paidSoFar(money(row.paid, book.currency), store.name)}
                  </p>
                  <div className="st-note mt-4 text-sm" role="status">
                    <p className="font-semibold" style={{ color: "var(--st-text)" }}>
                      {promise(store.affiliates)}
                    </p>
                    {due ? (
                      <p className="mt-1">{a.nextPayment(date(due))}</p>
                    ) : null}
                    {row.waiting > 0 ? (
                      <p className="mt-1">
                        {a.waitingNote(money(row.waiting, book.currency))}
                      </p>
                    ) : null}
                    {row.held > 0 ? (
                      <p className="mt-1" data-held="">
                        {a.heldNote(money(row.held, book.currency), store.name)}
                      </p>
                    ) : null}
                  </div>
                  {!book.refundsChecked ? (
                    <p className="st-note mt-4 text-sm" role="status">
                      {a.refundsUnchecked}
                    </p>
                  ) : null}

                  <AffiliatePromotionResults book={book} />
                  {/* Each lead with where it stands (lib/affiliate-lead-rules.ts), the person's address masked. */}
                  {book.lines.some((line) => line.how === "lead") ? (
                    <>
                      <h2 className="mt-8 text-lg font-semibold">{lw.head}</h2>
                      <ul className="mt-3 divide-y" style={{ borderColor: "var(--st-line)" }} data-leads>
                        {book.lines.filter((line) => line.how === "lead" && line.lead).slice(0, 50).map((line) => {
                          const status = line.status as LeadStatus;
                          const lead = line.lead!;
                          const words = [
                            lw.status[status],
                            ...(status === "in hold" || status === "waiting for the call" ? [lw.until(day(lead.readyAt))] : []),
                            ...(status === "not genuine" && lead.why ? [lw.reason[lead.why]] : []),
                          ].join(" · ");
                          return (
                            <li key={line.ref} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3" style={{ borderColor: "var(--st-line)" }}>
                              <span className="min-w-0">
                                <span className="block font-semibold">{`${lw.kind[lead.kind]}${line.title ? `: ${line.title}` : ""}`}</span>
                                <span className="st-muted block text-xs [overflow-wrap:anywhere]">{`${day(line.at)} · ${lead.email ? maskEmail(lead.email) : lw.deleted} · ${words}`}</span>
                              </span>
                              <span className="font-semibold tabular-nums">{money(line.commission, line.currency)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  ) : null}
                  <h2 className="mt-8 text-lg font-semibold">{a.salesHead}</h2>
                  {book.lines.filter((line) => line.how !== "lead").length === 0 ? (
                    <p className="st-muted mt-2 text-sm">{a.noneYet}</p>
                  ) : (
                    <ul className="mt-3 divide-y" style={{ borderColor: "var(--st-line)" }}>
                      {book.lines.filter((line) => line.how !== "lead").slice(0, 50).map((line) => (
                        <li key={line.ref} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3" style={{ borderColor: "var(--st-line)" }}>
                          <span className="min-w-0">
                            <span className="block font-semibold">{line.how === "bonus" ? bonusTitle(line.ref) : line.title || a.aProduct}</span>
                            <span className="st-muted block text-xs">
                              {line.how === "bonus"
                                ? a.bonusLine(day(line.at))
                                : line.how === "tier2"
                                  ? a.tierLine(day(line.at), money(line.base, line.currency), line.rate, line.status === "earned" ? "" : a.lineStatus[line.status] ?? line.status)
                                  : a.saleLine(day(line.at), money(line.base, line.currency), line.rate, line.status === "earned" ? "" : a.lineStatus[line.status] ?? line.status)}
                            </span>
                          </span>
                          <span className="font-semibold tabular-nums">{money(line.commission, line.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {book.payouts.length ? (
                    <>
                      <h2 className="mt-8 text-lg font-semibold">{a.paidByHead(store.name)}</h2>
                      <ul className="mt-3 space-y-2 text-sm">
                        {book.payouts.map((payout) => (
                          <li key={payout.id} className="flex flex-wrap justify-between gap-x-4">
                            <span>{`${payout.date}${payout.reference ? ` · ${payout.reference}` : ""}`}</span>
                            <span className="font-semibold tabular-nums">{money(payout.cents, payout.currency)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              ) : null}

              {affiliate.status === "approved" ? (
                <form id="payto" action="/api/store/affiliates/payto" method="post" className="mt-8 scroll-mt-24 space-y-2">
                  <input type="hidden" name="handle" value={store.handle} />
                  <label htmlFor="aff-paypal" className="st-label">
                    {a.payPalLabel}
                  </label>
                  <EmailField id="aff-paypal" name="paypal" className="st-field" autoComplete="email" placeholder={affiliate.email} defaultValue={affiliate.paypal} language={store.language} />
                  <p className="st-muted text-sm">
                    {a.payPalNote(store.name, affiliate.email)}
                  </p>
                  {status === "payto" || status === "payto-email" || status === "payto-slow" ? (
                    <p className={`st-note text-sm${status === "payto" ? "" : " font-semibold"}`} role="status">
                      {status === "payto" ? a.saved : status === "payto-email" ? a.payPalNotEmail : a.payPalSlow}
                    </p>
                  ) : null}
                  <button type="submit" className="btn btn-secondary btn-sm">
                    {a.savePayPal}
                  </button>
                </form>
              ) : null}

              <p className="mt-8 text-sm">
                <a href={`${SITE_URL}/affiliate`} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                  {a.allPrograms}
                </a>
              </p>
              <form action="/api/store/affiliates/signout" method="post" className="mt-2">
                <input type="hidden" name="handle" value={store.handle} />
                <button type="submit" className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                  {a.signOut}
                </button>
              </form>
            </>
          ) : order && buyersJoin(store) ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {a.earnPercent(terms.percent, store.name)}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {a.buyerJoinBody(store.name, terms.days, terms.percent)}
              </p>
              <form action="/api/store/affiliates/join" method="post" className="mt-7">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="order" value={order} />
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {a.getMyLink}
                </button>
              </form>
              <p className="st-muted mt-4 text-sm">
                {a.buyerJoinNote(promise(terms), store.name)}
              </p>
            </>
          ) : status === "sent" ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{a.checkInbox}</h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {a.sentBody(store.name)}
              </p>
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
                {on ? a.earnBy(store.name) : a.noProgram(store.name)}
              </h1>
              {on ? (
                <>
                  <ul className="mt-6 space-y-3">
                    {[
                      terms.recurring > 0 ? a.termShareAll(terms.percent, different.length > 0) : a.termShare(terms.percent, different.length > 0),
                      ...(terms.recurring > 0 ? [a.termRecurring(terms.recurring)] : []),
                      ...terms.bonuses.map((b) => a.termBonus(b.sales, money(b.cents, store.currency))),
                      ...(terms.lead.kind !== "none"
                        ? [lw.term(terms.lead.kind, money(terms.lead.cents, store.currency), store.name), lw.termRules(terms.lead.hold, terms.lead.daily, money(terms.lead.budget, store.currency), store.name)]
                        : []),
                      ...(terms.paidSearch ? [] : [a.termNoPaidSearch(store.name)]),
                      attribution(terms),
                      a.termRefunds,
                      a.termDisclose,
                      ...(terms.lead.kind !== "none" ? [lw.disclose] : []),
                      promise(terms),
                      store.affiliates.buyers ? a.termBuyers(store.name) : a.termApproves(store.name),
                    ].map((line) => (
                      <li key={line} className="flex gap-3">
                        <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--st-accent)" }} />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                  {different.length ? (
                    <ul className="st-muted mt-4 space-y-1 text-sm">
                      {different.map((p) => (
                        <li key={p.title}>{a.productRate(p.title, p.rate)}</li>
                      ))}
                    </ul>
                  ) : null}
                  {open ? form : (
                    <p className="st-muted mt-6 text-sm">{a.applyClosed}</p>
                  )}
                </>
              ) : (
                <p className="st-muted mt-4 text-lg leading-relaxed">
                  {a.whenOpens(store.name)}
                </p>
              )}
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
