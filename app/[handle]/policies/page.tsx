import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import { speech } from "@/lib/buyer-words";
import { POLICY_WORDS } from "@/lib/buyer-words/policies";
import { parseLanguage } from "@/lib/store-language";
import { notAdvice, policyFacts, policyFingerprint } from "@/lib/store-policy-facts";
import { paidPolicyInput } from "@/lib/store-policy-input";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";

type Params = { params: Promise<{ handle: string }> };

async function storeOf(raw: string) {
  const decoded = decodeURIComponent(raw);
  return decoded.startsWith("@") ? storeForPage(normaliseHandle(decoded)) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const store = await storeOf((await params).handle);
  if (!store) return { title: "Not found — Marktmorgen" };
  return { title: `${POLICY_WORDS[parseLanguage(store.language)].page} — ${store.name}`, robots: { index: false, follow: true } };
}

/**
 * A store's policies (617 [SZ1], unit 3): how it works, generated from its
 * real settings every time the page is drawn (lib/store-policy-input.ts,
 * lib/store-policy-facts.ts), in its own language, with the fingerprint of
 * these words as its version. Only true sentences, only what applies, and
 * never a promise of compliance. The creator's own words, the kept dated
 * versions and the links from the footer, the checkout and the email come
 * in later units.
 */
export default async function PoliciesPage({ params }: Params) {
  const store = await storeOf((await params).handle);
  if (!store) notFound();
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) redirect(`${SITE_URL}/@${store.handle}/policies`);

  // As the store's other public pages: the drawing is one of the window's requests (isResting), and the listings
  // it reads are paid for before they are read (paidPolicyInput); past the window, the resting page, nothing read.
  if (store.suspended) return <StoreResting store={store} suspended />;
  if (await isResting(store)) return <StoreResting store={store} />;
  const input = await paidPolicyInput(store);
  if (!input) return <StoreResting store={store} />;
  const words = POLICY_WORDS[parseLanguage(store.language)];
  const sections = policyFacts(input, store.language);
  if (sections.length === 0) notFound();
  const version = policyFingerprint(sections);
  const said = speech(store);

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <p className="text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
            {said.w.backTo(store.name)}
          </Link>
        </p>
        <h1 className="mt-6 font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{words.page}</h1>
        <p className="st-muted mt-2 text-sm">{store.name}</p>
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`policy-${section.id}`} className="mt-8">
            <h2 id={`policy-${section.id}`} className="font-display text-xl font-semibold">
              {section.title}
            </h2>
            {section.sentences.map((sentence, i) => (
              <p key={i} className="mt-3 leading-relaxed [overflow-wrap:anywhere]">
                {sentence}
              </p>
            ))}
          </section>
        ))}
        <p className="st-muted mt-10 text-sm">{notAdvice(store.language)}</p>
        <p className="st-muted mt-2 text-xs">{`${words.version} ${version}`}</p>
      </main>
    </div>
  );
}
