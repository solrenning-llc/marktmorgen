/**
 * What the page says, written once more in the form a search engine reads.
 *
 * Nothing here is new information. Every line restates something a visitor can
 * read on the page itself — the name of the company, the two prices, the
 * questions and their answers, who wrote an article and when — because a claim
 * that exists only in this file is a claim nobody can check, and search engines
 * treat that as a reason to distrust the rest of it.
 */
import { PUBLISHED_PLAN_PRICES as PLAN_PRICES, PLAN_TITLES as PLAN_NAMES, TIERS, TRIAL_DAYS, type Tier } from "@/lib/plan";
import { SITE_URL } from "@/lib/site-url";
import type { BlogPost } from "@/lib/blog";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE, PREVIEW_LINE } from "@/lib/opening";

/**
 * One block of structured data.
 *
 * The content is ours and is built here, never taken from anything a visitor
 * typed; `<` is escaped anyway, because a single one of those characters in a
 * string would end the script tag early and leave the rest of it on the page.
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

const ORGANIZATION = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: "Marktmorgen",
  url: SITE_URL,
  logo: `${SITE_URL}/icons/icon-512.png`,
  description:
    "A link-in-bio store for creators who sell files, courses, memberships and calls. Buyers pay into the creator's own Stripe account and " + feeWords().takesOfCreator,
};

/** The company and the site itself, on every page. */
export function SiteData() {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@graph": [
          ORGANIZATION,
          {
            "@type": "WebSite",
            "@id": `${SITE_URL}/#website`,
            url: SITE_URL,
            name: "Marktmorgen",
            publisher: { "@id": `${SITE_URL}/#organization` },
            inLanguage: "en",
          },
        ],
      }}
    />
  );
}

/**
 * The product and the questions answered on the cover. Prices are offers
 * only while paid plans can actually be started; otherwise the description
 * repeats the same preview notice visitors read.
 *
 * The prices are read from the same constants the pricing section prints, so
 * the two can never drift apart: changing a plan's price changes both.
 */
export function HomeData({ questions }: { questions: { q: string; a: string }[] }) {
  const offer = (tier: Tier) => ({
    "@type": "Offer",
    name: `${PLAN_NAMES[tier]}, monthly`,
    price: (PLAN_PRICES[tier].month / 100).toFixed(2),
    priceCurrency: "USD",
    url: `${SITE_URL}/#pricing`,
  });

  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "SoftwareApplication",
            "@id": `${SITE_URL}/#app`,
            name: "Marktmorgen",
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            url: SITE_URL,
            publisher: { "@id": `${SITE_URL}/#organization` },
            description: PLANS_ON_SALE
              ? `A store page for creators, with a ${TRIAL_DAYS}-day free trial. Sales are direct charges on the creator's own Stripe account. ${feeWords().takesOfCreator}`
              : PREVIEW_LINE,
            ...(PLANS_ON_SALE ? { offers: TIERS.map(offer) } : {}),
          },
          {
            "@type": "FAQPage",
            "@id": `${SITE_URL}/#faq`,
            mainEntity: questions.map((item) => ({
              "@type": "Question",
              name: item.q,
              acceptedAnswer: { "@type": "Answer", text: item.a },
            })),
          },
        ],
      }}
    />
  );
}

/** An article: who wrote it, when, and what it belongs to. */
export function ArticleData({ post }: { post: BlogPost }) {
  return (<>
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "@id": `${SITE_URL}/blog/${post.slug}#article`,
        headline: post.title,
        description: post.excerpt,
        datePublished: post.date,
        dateModified: post.date,
        articleSection: post.category,
        image: `${SITE_URL}/blog/${post.slug}/opengraph-image`,
        author: { "@type": "Organization", name: "Marktmorgen" },
        publisher: { "@id": `${SITE_URL}/#organization` },
        mainEntityOfPage: `${SITE_URL}/blog/${post.slug}`,
        inLanguage: "en",
      }}
    />
    {post.faq?.length ? <JsonLd data={{"@context":"https://schema.org","@type":"FAQPage","@id":`${SITE_URL}/blog/${post.slug}#faq`,mainEntity:post.faq.map(item=>({"@type":"Question",name:item.q,acceptedAnswer:{"@type":"Answer",text:item.a}}))}}/> : null}
  </>);
}
