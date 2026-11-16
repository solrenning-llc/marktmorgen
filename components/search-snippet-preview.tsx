import { DESCRIPTION_FROM_WORDS, type SearchSnippet, TITLE_FROM_WORDS, WAITING_WORDS } from "@/lib/product-search-snippet";

/**
 * "What search engines are given" under a product page's search fields in the
 * studio (248 [ST1]): the exact title and description its public page sends,
 * from the same rule as the page's metadata (lib/product-search-snippet.ts),
 * and where each part comes from. It follows what is typed above it, shows
 * what the page will send once it is saved, and promises nothing about how a
 * search engine lays out or ranks a result.
 */
export function SearchSnippetPreview({ snippet }: { snippet: SearchSnippet }) {
  return (
    <section aria-labelledby="search-snippet-title" className="rounded-xl p-4 ring-1 ring-line" data-search-snippet="">
      <h3 id="search-snippet-title" className="text-sm font-semibold text-ink">
        What search engines are given
      </h3>
      <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-ink-soft">
        Once you save, the page gives search engines and shared links this title and description. Search engines decide what they show and where; nobody can promise a place in results.
      </p>
      {snippet.waiting ? (
        <p className="mt-2 max-w-[80ch] text-xs font-semibold leading-relaxed text-ink" data-snippet-waiting="">
          {WAITING_WORDS}
        </p>
      ) : null}
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="font-semibold text-ink">Title</dt>
          <dd className="mt-0.5 break-words text-ink" data-snippet-title={snippet.titleFrom}>
            {snippet.title}
          </dd>
          <dd className="mt-0.5 max-w-[80ch] text-xs leading-relaxed text-ink-soft">{TITLE_FROM_WORDS[snippet.titleFrom]}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">Description</dt>
          <dd className="mt-0.5 break-words text-ink" data-snippet-description={snippet.descriptionFrom}>
            {snippet.description}
          </dd>
          <dd className="mt-0.5 max-w-[80ch] text-xs leading-relaxed text-ink-soft">{DESCRIPTION_FROM_WORDS[snippet.descriptionFrom]}</dd>
        </div>
      </dl>
    </section>
  );
}
