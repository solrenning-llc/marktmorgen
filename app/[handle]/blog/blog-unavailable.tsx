import { wordsIn } from "@/lib/buyer-words";
import { blogReadingWords } from "@/lib/buyer-words/blog-reading";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

/** A failed reading is not an empty blog or a missing store. No post list is invented. */
export function BlogUnavailable({ language, handle, name }: { language: unknown; handle: string; name: string }) {
 const code = parseLanguage(language), words = blogReadingWords(code);
 const base = `/@${encodeURIComponent(handle)}`;
 return <div lang={LANGUAGES[code].locale} className="min-h-screen bg-paper text-ink">
  <meta name="robots" content="noindex" />
  <main id="content" className="container-page max-w-2xl py-16">
   <a href={base} className="link inline-flex min-h-11 items-center">{name}</a>
   <h1 className="t-h2 mt-6">{wordsIn(code).blogOf(name)}</h1>
   <p role="status" className="notice mt-6">{words.unavailable}</p>
   <a href={`${base}/blog`} className="btn btn-secondary mt-6 min-h-11">{words.retry}</a>
  </main>
 </div>;
}
