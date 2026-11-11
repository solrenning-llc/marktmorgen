import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { formWords } from "@/lib/buyer-words/form";
import { funnelWords } from "@/lib/buyer-words/funnel";
import { readForm } from "@/lib/form-store";
import { branches, readScoreQuery } from "@/lib/forms";
import { readListing } from "@/lib/catalog";
import { productPath } from "@/components/store-product";
import { funnelMark } from "@/lib/page-funnel";
import { funnelHere } from "@/lib/page-funnel-store";
import { PlainText } from "@/components/sales-blocks";

type Params = {
  params: Promise<{ handle: string; form: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const pick = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${formWords(store?.language).doneHeading} — ${store?.name ?? "Marktmorgen"}`, robots: { index: false, follow: false } };
}

/**
 * After a form is sent (app/api/store/form): the quiz's result when it has
 * one, with the creator's product for it, or the form's own thank-you; that
 * the list's email is on its way when they asked for it; and, on a step of a
 * funnel, the way on to the next one. Nothing here is personal: the result
 * is named in the address, and anyone who opens it sees what a quiz says
 * for that result, nothing of anybody's answers. A scored quiz's total
 * comes the same way (lib/forms.ts, readScoreQuery), and is shown only when
 * this result's range holds it, with the range itself, so a person sees why
 * this is their result; "of N" only when no answer skips a question, as N is
 * then the most anybody could score.
 */
export default async function FormDonePage({ params, searchParams }: Params) {
  const { handle, form: formId } = await params;
  const query = await searchParams;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store || store.suspended) notFound();
  // As the store page (lib/traffic.ts, isResting): one of the store's counted public requests, and a store whose
  // window's requests are used rests, before the form, its product and its funnel are read.
  if (await isResting(store)) return <StoreResting store={store} />;
  const form = await readForm(store.statsId, formId).catch(() => null);
  if (!form) notFound();
  const w = formWords(store.language);
  const { lang } = speech(store);
  const outcome = form.outcomes.find((o) => o.id === pick(query.r)) ?? null;
  const score = readScoreQuery(form, outcome, pick(query.s), pick(query.c));
  const whole = !branches(form);
  const product = outcome?.product ? await readListing(store, outcome.product).catch(() => null) : null;
  const shown = product && !product.hidden ? product : null;
  const page = store.sitePages.find((p) => p.id === pick(query.p)) ?? null;
  const here = page ? await funnelHere(store, funnelMark(pick(query.f)), "page", page.id).catch(() => null) : null;

  return (
    <div lang={lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16" data-form-done={form.id}>
        <div className="st-card p-7 sm:p-10">
          {outcome ? (
            <>
              <p className="st-price text-sm">{w.result}</p>
              <h1 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl">{outcome.title}</h1>
              {outcome.body ? <PlainText text={outcome.body} className="st-muted mt-4 text-lg" /> : null}
              {score ? (
                <div className="mt-6" data-quiz-score={score.total}>
                  <p className="text-lg font-semibold">{`${w.yourScore}: ${w.points(score.total, whole ? score.top : null)}`}</p>
                  {typeof outcome.min === "number" && typeof outcome.max === "number" ? <p className="st-muted mt-1 text-sm">{w.covers(outcome.min, outcome.max)}</p> : null}
                  {score.categories.length ? (
                    <ul className="mt-4 space-y-3">
                      {score.categories.map((c) => (
                        <li key={c.id}>
                          <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span className="font-semibold">{c.name}</span>
                            <span className="st-muted">{w.points(c.points, whole ? c.top : null)}</span>
                          </div>
                          {whole && c.top > 0 ? (
                            <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: "var(--st-accent-soft)" }} aria-hidden="true">
                              <div className="h-full rounded-full" style={{ width: `${Math.round((c.points / c.top) * 100)}%`, background: "var(--st-accent)" }} />
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{form.doneHeading || w.doneHeading}</h1>
              {form.doneBody ? <PlainText text={form.doneBody} className="st-muted mt-4 text-lg" /> : <p className="st-muted mt-4 text-lg">{w.doneBody(store.name)}</p>}
            </>
          )}
          {pick(query.j) === "1" ? <p className="notice notice-success mt-6 text-sm">{w.confirmSent}</p> : null}
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            {here?.next ? (
              <Link href={here.next} className="btn st-btn btn-lg">
                {funnelWords(store.language).next}
              </Link>
            ) : shown ? (
              <Link href={productPath(store, shown)} className="btn st-btn btn-lg">
                {`${w.seeProduct}: ${shown.title}`}
              </Link>
            ) : null}
            {here?.next && shown ? (
              <Link href={productPath(store, shown)} className="st-footer-link text-sm font-semibold">
                {`${w.seeProduct}: ${shown.title}`}
              </Link>
            ) : null}
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
