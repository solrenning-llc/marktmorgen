import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { membershipWords } from "@/lib/buyer-words/membership";
import { previewSwitch } from "@/lib/tier-switch";
import { YEARLY_TARGET, previewYearly } from "@/lib/yearly-switch";
import { DigitalConsentBox } from "@/components/digital-consent-box";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).switchTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * What a switch to another tier costs, in Stripe's own figures, before
 * anything happens (lib/tier-switch.ts). Opening this page changes nothing;
 * only its button does.
 */
export default async function SwitchPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const token = read("token");
  const sub = read("sub");
  const to = read("to");
  // Reached from the page that asked why before cancelling (lib/leave-rules.ts).
  const fromLeave = read("from") === "leave";
  // `from=offer`: the link in the email that offers it (lib/yearly-ask.ts), which works for 14 days.
  // Sent back here by the button when the EU box was not checked (app/api/store/manage/switch): it says what is missing.
  const consentNeeded = read("consent") === "needed";
  if (to === YEARLY_TARGET) return <YearlyPage store={store} token={token} sub={sub} fromOffer={read("from") === "offer"} consentNeeded={consentNeeded} />;
  const result = await previewSwitch(store, token, sub, to);
  const back = `/@${store.handle}/manage${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const m = membershipWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  // Stripe's own figures, in its own currency, written the store's way.
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale);

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          {result.ok ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{m.switchTo(result.preview.to.title)}</h1>
              <ul className="mt-6 space-y-3">
                <li className="st-row">
                  <div className="min-w-0">
                    <p className="st-muted text-xs font-semibold uppercase tracking-wide">{m.nowLabel}</p>
                    <p className="font-bold" style={{ color: "var(--st-text)" }}>{result.preview.from.title}</p>
                    <p className="st-muted text-sm">{result.preview.from.words}</p>
                  </div>
                </li>
                <li className="st-row">
                  <div className="min-w-0">
                    <p className="st-muted text-xs font-semibold uppercase tracking-wide">{m.afterLabel}</p>
                    <p className="font-bold" style={{ color: "var(--st-text)" }}>{result.preview.to.title}</p>
                    <p className="st-muted text-sm">{result.preview.to.words}</p>
                  </div>
                </li>
              </ul>
              <div className="st-note mt-6">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>
                  {result.preview.trialing
                    ? m.nothingNow
                    : result.preview.due > 0
                      ? m.chargedToday(money(result.preview.due, result.preview.currency))
                      : result.preview.due < 0
                        ? m.offNext(money(-result.preview.due, result.preview.currency))
                        : m.nothingToday}
                </p>
                <p className="mt-1 text-sm">
                  {result.preview.trialing
                    ? m.switchTrialNote
                    : result.preview.due > 0
                      ? m.dueNote
                      : result.preview.due < 0
                        ? m.creditNote
                        : m.opensNow}
                </p>
              </div>
              <form action="/api/store/manage/switch" method="post" className="mt-6">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="sub" value={result.preview.sub} />
                <input type="hidden" name="to" value={result.preview.to.id} />
                <input type="hidden" name="at" value={String(result.preview.at)} />
                {fromLeave ? <input type="hidden" name="from" value="leave" /> : null}
                {/* The new tier opens at once: the EU box again, before anything is charged (91 [D2-EU-WITHDRAWAL]). */}
                {result.preview.digital ? <DigitalConsentBox id={`dc-switch-${result.preview.to.id}`} kind="membership" lang={store.language} refused={consentNeeded} className="mb-5" /> : null}
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {result.preview.due > 0 && !result.preview.trialing ? m.switchAndPay(money(result.preview.due, result.preview.currency)) : m.switchNow}
                </button>
              </form>
              <p className="st-muted mt-4 text-sm">
                {m.holdsNote(store.name, result.preview.from.title)}
              </p>
            </>
          ) : (
            <div className="st-note">
              <h1 className="font-bold" style={{ color: "var(--st-text)" }}>{m.switchProblems[result.reason].title}</h1>
              <p className="mt-1 text-sm">{m.switchProblems[result.reason].body}</p>
            </div>
          )}
        </div>
        <div className="mt-8 text-center">
          <Link href={back} className="st-footer-link text-sm font-semibold">
            {m.backToMembership}
          </Link>
        </div>
      </main>
    </div>
  );
}

/**
 * The same membership, paid yearly (lib/yearly-switch.ts): what moving costs
 * today, in Stripe's own figures, before anything happens. Reached from the
 * member's page or from the one email that offers it, whose link opens this
 * switch and nothing else.
 */
async function YearlyPage({ store, token, sub, fromOffer, consentNeeded }: { store: NonNullable<Awaited<ReturnType<typeof storeForPage>>>; token: string; sub: string; fromOffer: boolean; consentNeeded: boolean }) {
  const result = await previewYearly(store, token, sub);
  // The emailed link opens nothing else, so going back means asking for the member's own link.
  const back = `/@${store.handle}/manage${token && !result.emailed && !fromOffer ? `?token=${encodeURIComponent(token)}` : ""}`;
  const m = membershipWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale);
  const problem = result.ok ? null : result.reason === "expired" && fromOffer ? m.switchProblems.yearlyExpired : m.switchProblems[result.reason];

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9" data-yearly-switch>
          {result.ok ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{m.yearlyHead(result.preview.title)}</h1>
              <ul className="mt-6 space-y-3">
                <li className="st-row">
                  <div className="min-w-0">
                    <p className="st-muted text-xs font-semibold uppercase tracking-wide">{m.nowLabel}</p>
                    <p className="font-bold" style={{ color: "var(--st-text)" }}>{result.preview.monthlyWords}</p>
                  </div>
                </li>
                <li className="st-row">
                  <div className="min-w-0">
                    <p className="st-muted text-xs font-semibold uppercase tracking-wide">{m.afterLabel}</p>
                    <p className="font-bold" style={{ color: "var(--st-text)" }}>{result.preview.yearlyWords}</p>
                    <p className="st-muted text-sm">{m.yearlySaves(money(result.preview.saving, store.currency))}</p>
                  </div>
                </li>
              </ul>
              <div className="st-note mt-6">
                <p className="font-bold" style={{ color: "var(--st-text)" }} data-yearly-due>
                  {result.preview.trialing ? m.nothingNow : result.preview.due > 0 ? m.chargedToday(money(result.preview.due, result.preview.currency)) : m.nothingToday}
                </p>
                <p className="mt-1 text-sm">{result.preview.trialing ? m.yearlyTrialNote : m.yearlyDueNote}</p>
              </div>
              <form action="/api/store/manage/switch" method="post" className="mt-6">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="sub" value={result.preview.sub} />
                <input type="hidden" name="to" value={YEARLY_TARGET} />
                <input type="hidden" name="at" value={String(result.preview.at)} />
                {fromOffer ? <input type="hidden" name="from" value="offer" /> : null}
                {result.preview.digital ? <DigitalConsentBox id="dc-switch-yearly" kind="membership" lang={store.language} refused={consentNeeded} className="mb-5" /> : null}
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {result.preview.due > 0 && !result.preview.trialing ? m.switchAndPay(money(result.preview.due, result.preview.currency)) : m.switchNow}
                </button>
              </form>
              <p className="st-muted mt-4 text-sm">{m.yearlyHolds(store.name)}</p>
            </>
          ) : problem ? (
            <div className="st-note">
              <h1 className="font-bold" style={{ color: "var(--st-text)" }}>{problem.title}</h1>
              <p className="mt-1 text-sm">{problem.body}</p>
            </div>
          ) : null}
        </div>
        <div className="mt-8 text-center">
          <Link href={back} className="st-footer-link text-sm font-semibold">
            {m.backToMembership}
          </Link>
        </div>
      </main>
    </div>
  );
}
