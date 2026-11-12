import type { Book } from "@/lib/affiliates";
import { affiliatePromotionRows } from "@/lib/affiliate-promotion";
import { affiliateToolWords } from "@/lib/buyer-words/affiliate-tools";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

/** Commission by campaign and post, in the store's language, each count and amount written its way. */
export function AffiliatePromotionResults({ book, language }: { book: Book; language?: LanguageCode }) {
  const t = affiliateToolWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const num = (n: number) => n.toLocaleString(locale);
  const complete = book.refundsChecked && book.invoicesChecked;
  if (!complete) return <section className="mt-8"><h2 className="text-lg font-semibold">{t.resultsHead}</h2><p className="st-muted mt-2 text-sm">{t.resultsWaiting}</p></section>;
  const rows = affiliatePromotionRows(book.lines);
  if (!rows.length) return null;
  return <section className="mt-8" aria-labelledby="affiliate-promotion-results">
    <h2 id="affiliate-promotion-results" className="text-lg font-semibold">{t.resultsHead}</h2>
    <p className="st-muted mt-2 text-sm">{t.resultsIntro}</p>
    <div className="mt-3 overflow-x-auto" role="region" tabIndex={0} aria-label={t.resultsRegion}>
      <table className="w-full text-left text-sm">
        <thead><tr><th scope="col" className="py-2">{t.channel}</th><th scope="col" className="px-3">{t.campaign}</th><th scope="col" className="px-3">{t.postVariant}</th><th scope="col" className="px-3 text-right">{t.paidRecords}</th><th scope="col" className="pl-3 text-right">{t.commission}</th></tr></thead>
        <tbody>{rows.slice(0,50).map(row=><tr key={JSON.stringify([row.currency,row.promotion])} className="border-t" style={{borderColor:"var(--st-line)"}}>
          <td className="py-2">{row.promotion?.source || t.unlabeled}</td><td className="px-3">{row.promotion?.campaign || t.unlabeled}</td><td className="px-3">{row.promotion?.content || t.unlabeled}</td><td className="px-3 text-right tabular-nums">{num(row.paidRecords)}</td><td className="pl-3 text-right tabular-nums">{formatMoney(row.commission,row.currency,locale)} <span className="st-muted">{row.currency.toUpperCase()}</span></td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="st-muted mt-2 text-xs">{t.showing(num(Math.min(50,rows.length)), num(rows.length))}</p>
  </section>;
}
